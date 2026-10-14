/*
 * Cuánto pedir: la página.
 *
 * Lee los archivos que la persona elige (o los de ejemplo), muestra las
 * columnas que reconoció para que las corrija, corre la cuenta de calculo.js
 * por tandas y pinta el resumen, la tabla y el detalle de cada producto con
 * sus dos gráficos. Todo pasa en el navegador: la página no envía nada.
 */
(function () {
  'use strict';

  const C = window.Calculo;
  const Ejemplo = window.Ejemplo;
  const NS = 'http://www.w3.org/2000/svg';

  // El lector de Excel se descarga solo cuando hace falta, con versión fija y
  // huella de integridad: si el archivo de la red cambiara, el navegador no lo corre.
  const SHEETJS = {
    src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    integridad: 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA=='
  };

  const ETIQUETAS = {
    fecha: 'Fecha',
    producto: 'Producto o código',
    cantidad: 'Cantidad',
    nombre: 'Nombre del producto',
    existencias: 'Existencias',
    enCamino: 'En camino',
    plazo: 'Plazo en días',
    costo: 'Costo por unidad',
    precio: 'Precio de venta',
    margen: 'Margen por unidad'
  };
  const SIEMPRE_VISIBLES = {
    historial: ['fecha', 'producto', 'cantidad', 'nombre', 'existencias'],
    existencias: ['producto', 'existencias', 'enCamino', 'nombre'],
    plazos: ['producto', 'plazo', 'nombre']
  };
  const TANDA = 40;
  const PAGINA = 200;

  const estado = {
    archivos: { historial: null, existencias: null, plazos: null },
    version: 0,
    preparado: null,
    contexto: null,
    resultados: [],
    resumen: null,
    parametros: null,
    orden: { columna: 'estado', ascendente: true },
    filtro: { texto: '', tipo: 'todos', soloPedir: false },
    abierto: null,
    mostrar: PAGINA,
    calculo: 0,
    esEjemplo: false,
    graficos: []
  };

  // ------------------------------------------------------------ utilidades

  function $(id) {
    return document.getElementById(id);
  }

  function poner(nodo, atributos, hijos) {
    if (atributos) {
      for (const [k, v] of Object.entries(atributos)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'texto') nodo.textContent = v;
        else if (k === 'clase') nodo.setAttribute('class', v);
        else if (k.startsWith('on') && typeof v === 'function') nodo.addEventListener(k.slice(2), v);
        else nodo.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const h of hijos.flat(Infinity)) {
      if (h === null || h === undefined || h === false) continue;
      nodo.append(h instanceof Node ? h : String(h));
    }
    return nodo;
  }

  /** Crea un elemento. Los textos entran como texto, nunca como HTML: el contenido del archivo no puede inyectar nada. */
  function el(etiqueta, atributos, ...hijos) {
    return poner(document.createElement(etiqueta), atributos, hijos);
  }

  function svg(etiqueta, atributos, ...hijos) {
    return poner(document.createElementNS(NS, etiqueta), atributos, hijos);
  }

  function icono(nombre) {
    const trazos = {
      aviso: 'M12 3.5 21 19.5H3Z M12 10v4.2 M12 16.6v.4',
      info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 11v5.5 M12 7.8v.4',
      bien: 'M5 12.5 10 17.5 19 7'
    };
    return svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
      svg('path', { d: trazos[nombre], fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  function f(numero, decimales = 0) {
    return C.formatear(numero, decimales);
  }

  function decimales() {
    return estado.contexto ? estado.contexto.historial.decimales : 0;
  }

  function cantidad(numero) {
    return f(numero, decimales());
  }

  function venta(numero) {
    return f(numero, C.decimalesVenta(numero));
  }

  function dinero(numero) {
    return 'USD ' + f(numero, 2);
  }

  function plural(n, uno, varios) {
    return f(n) + ' ' + (n === 1 ? uno : varios);
  }

  function lista(partes, conjuncion = 'y') {
    if (partes.length <= 1) return partes.join('');
    return partes.slice(0, -1).join(', ') + ' ' + conjuncion + ' ' + partes[partes.length - 1];
  }

  function pausa() {
    return new Promise((resolver) => setTimeout(resolver, 0));
  }

  function sinMovimiento() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function ranuraDe(tipo) {
    return document.querySelector('.ranura[data-ranura="' + tipo + '"]');
  }

  function descargar(nombre, texto) {
    const blob = new Blob([texto], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: nombre });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ------------------------------------------------------------------ tema

  function iniciarTema() {
    const boton = $('boton-tema');
    const raiz = document.documentElement;
    const sistema = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const oscuro = () => (raiz.getAttribute('data-theme') || (sistema && sistema.matches ? 'dark' : 'light')) === 'dark';
    const pintar = () => boton.setAttribute('aria-pressed', String(oscuro()));
    boton.addEventListener('click', () => {
      const nuevo = oscuro() ? 'light' : 'dark';
      raiz.setAttribute('data-theme', nuevo);
      try {
        window.localStorage.setItem('cuanto-pedir-tema', nuevo);
      } catch (e) {
        // Sin almacenamiento: el cambio dura mientras la página esté abierta.
      }
      pintar();
    });
    if (sistema && sistema.addEventListener) sistema.addEventListener('change', pintar);
    pintar();
  }

  // ------------------------------------------- la sierra de la cabecera

  function poisson(lambda, azar) {
    const limite = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= azar();
    } while (p > limite);
    return k - 1;
  }

  /**
   * Las existencias de un producto con la regla puesta: bajan con la venta,
   * tocan la raya del punto de pedido, se pide y el lote llega diez días
   * después. El mismo dibujo que explica la herramienta.
   */
  function dibujarSierra(animar) {
    const lienzo = $('sierra');
    const ancho = Math.max(320, Math.round(lienzo.getBoundingClientRect().width || document.documentElement.clientWidth));
    const alto = ancho < 640 ? 84 : 120;
    lienzo.setAttribute('viewBox', '0 0 ' + ancho + ' ' + alto);
    lienzo.setAttribute('height', String(alto));
    lienzo.replaceChildren();

    const azar = C.generador(1777);
    const dias = ancho < 640 ? 80 : 140;
    const punto = 51;
    const lote = 120;
    const plazo = 10;
    let hay = 150;
    const llegadas = [];
    const trazo = [];
    const pedidos = [];
    for (let d = 0; d < dias; d++) {
      const llegan = llegadas.filter((x) => x === d).length;
      if (llegan) {
        trazo.push([d, hay]);
        hay += lote * llegan;
      }
      trazo.push([d, hay]);
      hay = Math.max(0, hay - poisson(4, azar));
      if (hay + lote * llegadas.filter((x) => x > d).length <= punto) {
        llegadas.push(d + 1 + plazo);
        pedidos.push([d + 1, hay]);
      }
    }
    trazo.push([dias, hay]);
    const x = (d) => (d / dias) * ancho;
    const y = (v) => alto - 8 - (v / 200) * (alto - 22);
    const camino = trazo.map((p, i) => (i ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');

    lienzo.append(svg('line', { clase: 'horizonte', x1: 0, x2: ancho, y1: y(punto).toFixed(1), y2: y(punto).toFixed(1) }));
    const linea = svg('path', { clase: 'existencias', d: camino });
    lienzo.append(linea);
    for (const p of pedidos) lienzo.append(svg('circle', { clase: 'pedido', cx: x(p[0]).toFixed(1), cy: y(punto).toFixed(1), r: 3.5 }));
    // La etiqueta va debajo de la raya, alineada con el texto de la página, donde
    // la línea todavía no baja; el fondo del color de la noche la protege igual.
    const etiqueta = 'punto de pedido';
    const anchoEtiqueta = etiqueta.length * 7.1 + 8;
    const xEtiqueta = Math.max(16, (ancho - 1120) / 2 + (ancho >= 720 ? 32 : 16));
    lienzo.append(svg('rect', { clase: 'fondo-texto', x: (xEtiqueta - 4).toFixed(1), y: (y(punto) + 4).toFixed(1), width: anchoEtiqueta.toFixed(1), height: 16 }));
    lienzo.append(svg('text', { x: xEtiqueta.toFixed(1), y: (y(punto) + 16).toFixed(1), 'text-anchor': 'start', texto: etiqueta }));

    if (animar && !sinMovimiento() && linea.getTotalLength) {
      const largo = Math.ceil(linea.getTotalLength());
      linea.style.strokeDasharray = String(largo);
      linea.style.strokeDashoffset = String(largo);
      lienzo.classList.add('animar');
    } else {
      lienzo.classList.remove('animar');
    }
  }

  // ------------------------------------------------------ leer archivos

  let promesaSheetJS = null;

  function cargarSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!promesaSheetJS) {
      promesaSheetJS = new Promise((resolver, rechazar) => {
        const s = document.createElement('script');
        s.src = SHEETJS.src;
        s.integrity = SHEETJS.integridad;
        s.crossOrigin = 'anonymous';
        s.referrerPolicy = 'no-referrer';
        s.onload = () => (window.XLSX ? resolver(window.XLSX) : rechazar(Object.assign(new Error('lector'), { codigo: 'sin-lector' })));
        s.onerror = () => {
          promesaSheetJS = null;
          s.remove();
          rechazar(Object.assign(new Error('lector'), { codigo: 'sin-lector' }));
        };
        document.head.append(s);
      });
    }
    return promesaSheetJS;
  }

  async function leerArchivo(archivo) {
    const nombre = archivo.name || 'archivo';
    if (/\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(nombre)) {
      const XLSX = await cargarSheetJS();
      let libro;
      try {
        libro = XLSX.read(new Uint8Array(await archivo.arrayBuffer()), { type: 'array' });
      } catch (e) {
        throw Object.assign(new Error('excel'), { codigo: 'excel-ilegible' });
      }
      const fecha1904 = Boolean(libro.Workbook && libro.Workbook.WBProps && libro.Workbook.WBProps.date1904);
      const hojas = libro.SheetNames
        .map((n) => ({ nombre: n, filas: XLSX.utils.sheet_to_json(libro.Sheets[n], { header: 1, raw: true, defval: '', blankrows: false }) }))
        .filter((h) => h.filas.length);
      return { nombre, hojas, fecha1904, delimitador: null };
    }
    const datos = await archivo.arrayBuffer();
    let texto;
    try {
      texto = new TextDecoder('utf-8', { fatal: true }).decode(datos);
    } catch (e) {
      // Excel en Windows guarda los CSV en la codificación de siempre, no en UTF-8.
      texto = new TextDecoder('windows-1252').decode(datos);
    }
    const { filas, delimitador } = C.leerCSV(texto);
    return { nombre, hojas: [{ nombre, filas }], fecha1904: false, delimitador };
  }

  function mensajeError(nombre, error) {
    if (error && error.codigo === 'sin-lector') {
      return 'Para leer Excel, la página descarga un lector la primera vez y no pudo hacerlo; puede que no haya internet. ' +
        'Guarde el archivo como CSV desde Excel (Archivo, Guardar como, CSV) y súbalo: el CSV se lee sin conexión.';
    }
    if (error && error.codigo === 'excel-ilegible') {
      return 'No se pudo abrir «' + nombre + '». Si tiene contraseña o está dañado, ábralo en Excel y guárdelo como CSV.';
    }
    if (error && error.codigo === 'vacio') return '«' + nombre + '» no tiene filas con datos.';
    return 'No se pudo leer «' + nombre + '». Pruebe guardarlo como CSV desde Excel.';
  }

  function iniciarRanuras() {
    for (const tipo of ['historial', 'existencias', 'plazos']) {
      const ranura = ranuraDe(tipo);
      const entrada = ranura.querySelector('input[type="file"]');
      const zona = ranura.querySelector('.soltar');
      entrada.addEventListener('change', () => {
        if (entrada.files && entrada.files[0]) recibirArchivo(tipo, entrada.files[0]);
        entrada.value = '';
      });
      zona.addEventListener('dragover', (e) => {
        e.preventDefault();
        zona.classList.add('encima');
      });
      zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
      zona.addEventListener('drop', (e) => {
        e.preventDefault();
        zona.classList.remove('encima');
        const archivo = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (archivo) recibirArchivo(tipo, archivo);
      });
    }
    // Un archivo soltado fuera de las zonas no debe abrirse en la pestaña.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  async function recibirArchivo(tipo, archivo) {
    const nodo = ranuraDe(tipo).querySelector('.ranura-estado');
    nodo.replaceChildren(el('span', { clase: 'archivo-detalle', texto: 'Leyendo «' + archivo.name + '»…' }));
    try {
      const leido = await leerArchivo(archivo);
      if (!leido.hojas.some((h) => h.filas.length > 1)) throw Object.assign(new Error('vacío'), { codigo: 'vacio' });
      if (tipo === 'historial') {
        estado.esEjemplo = false;
        $('estado-carga').replaceChildren();
      }
      cargarEnRanura(tipo, leido, 'archivo');
    } catch (error) {
      nodo.replaceChildren(el('p', { clase: 'error', role: 'alert', texto: mensajeError(archivo.name, error) }));
    }
  }

  function aplicarHoja(archivo, indice) {
    archivo.hoja = indice;
    archivo.filas = archivo.hojas[indice].filas;
    archivo.estructura = C.leerEstructura(archivo.filas, archivo.tipo);
    archivo.columnas = Object.assign({}, archivo.estructura.columnas);
  }

  function cargarEnRanura(tipo, leido, origen) {
    let mejor = 0;
    let mejorPuntaje = -1;
    leido.hojas.forEach((hoja, i) => {
      const e = C.leerEstructura(hoja.filas, tipo);
      const puntaje = C.REQUERIDOS[tipo].filter((c) => e.columnas[c] >= 0).length * 1e6 + hoja.filas.length;
      if (puntaje > mejorPuntaje) {
        mejor = i;
        mejorPuntaje = puntaje;
      }
    });
    const archivo = {
      tipo, nombre: leido.nombre, hojas: leido.hojas, fecha1904: leido.fecha1904,
      delimitador: leido.delimitador, origen, masAbierto: false
    };
    aplicarHoja(archivo, mejor);
    estado.archivos[tipo] = archivo;
    estado.version += 1;
    pintarRanura(tipo);
    programarCalculo(true);
  }

  function quitarArchivo(tipo) {
    estado.archivos[tipo] = null;
    if (tipo === 'historial') {
      estado.esEjemplo = false;
      $('estado-carga').replaceChildren();
    }
    estado.version += 1;
    pintarRanura(tipo);
    programarCalculo(true);
  }

  function valorVista(archivo, i, valor) {
    if (valor === null || valor === undefined) return '';
    if (i === archivo.columnas.fecha && typeof valor === 'number') {
      const dia = C.leerFecha(valor, 'dma', { fecha1904: archivo.fecha1904 });
      if (Number.isFinite(dia)) return C.fechaCorta(dia);
    }
    return String(valor);
  }

  function selectorColumna(archivo, campo) {
    const requerido = C.REQUERIDOS[archivo.tipo].includes(campo);
    const id = 'col-' + archivo.tipo + '-' + campo;
    const falta = requerido && !(archivo.columnas[campo] >= 0);
    const select = el('select', {
      id,
      'aria-invalid': falta ? 'true' : null,
      onchange: (e) => {
        archivo.columnas[campo] = Number(e.target.value);
        estado.version += 1;
        pintarRanura(archivo.tipo);
        programarCalculo(true);
        const nuevo = $(id);
        if (nuevo) nuevo.focus();
      }
    },
    el('option', { value: '-1', texto: requerido ? 'Elija la columna' : 'Ninguna' }),
    archivo.estructura.titulos.map((t, i) => el('option', { value: String(i), selected: archivo.columnas[campo] === i, texto: t })));
    return el('div', {},
      el('label', { for: id }, ETIQUETAS[campo], requerido ? null : el('span', { clase: 'opcional', texto: ' (opcional)' })),
      select,
      falta ? el('span', { clase: 'falta', texto: 'Falta esta columna.' }) : null);
  }

  function pintarRanura(tipo) {
    const ranura = ranuraDe(tipo);
    const nodo = ranura.querySelector('.ranura-estado');
    const caja = ranura.querySelector('.ranura-columnas');
    const a = estado.archivos[tipo];
    if (!a) {
      nodo.replaceChildren();
      caja.replaceChildren();
      caja.hidden = true;
      return;
    }
    const filasDatos = a.filas.length - a.estructura.desde;
    nodo.replaceChildren(el('div', { clase: 'archivo-cargado' },
      el('span', { clase: 'archivo-nombre', texto: a.nombre }),
      el('span', { clase: 'archivo-detalle', texto: plural(filasDatos, 'fila', 'filas') + (a.origen === 'ejemplo' ? ' · datos de ejemplo' : '') }),
      el('button', { type: 'button', clase: 'boton-enlace', texto: 'Quitar', onclick: () => quitarArchivo(tipo) })));

    const hijos = [el('h3', { texto: 'Columnas' })];
    const porContenido = a.estructura.porContenido.filter((c) => a.columnas[c] === a.estructura.columnas[c]);
    hijos.push(el('p', {
      clase: 'nota',
      texto: porContenido.length
        ? 'Algunas columnas se reconocieron por lo que contienen y no por su nombre (' + lista(porContenido.map((c) => ETIQUETAS[c].toLowerCase())) + '). Revíselas.'
        : 'Estas son las columnas que se reconocieron. Si alguna no es, elija la correcta.'
    }));
    if (a.hojas.length > 1) {
      const id = 'hoja-' + tipo;
      hijos.push(el('div', { clase: 'hoja' },
        el('label', { for: id, texto: 'Hoja del libro' }),
        el('select', {
          id,
          onchange: (e) => {
            aplicarHoja(a, Number(e.target.value));
            estado.version += 1;
            pintarRanura(tipo);
            programarCalculo(true);
          }
        }, a.hojas.map((h, i) => el('option', { value: String(i), selected: i === a.hoja, texto: h.nombre })))));
    }
    const visibles = SIEMPRE_VISIBLES[tipo];
    const otros = C.CAMPOS[tipo].filter((c) => !visibles.includes(c));
    hijos.push(el('div', { clase: 'mapa' }, visibles.map((c) => selectorColumna(a, c)), otros.filter((c) => a.columnas[c] >= 0).map((c) => selectorColumna(a, c))));
    const ocultos = otros.filter((c) => !(a.columnas[c] >= 0));
    if (ocultos.length) {
      const mas = el('details', { clase: 'opcionales-mas' },
        el('summary', { texto: 'Más columnas: ' + lista(ocultos.map((c) => ETIQUETAS[c].toLowerCase())) }),
        el('div', { clase: 'mapa' }, ocultos.map((c) => selectorColumna(a, c))));
      mas.open = a.masAbierto;
      mas.addEventListener('toggle', () => { a.masAbierto = mas.open; });
      hijos.push(mas);
    }

    // Vista previa: las primeras filas tal como vienen, con la columna que se usa para cada cosa.
    const uso = new Map();
    for (const [campo, i] of Object.entries(a.columnas)) if (i >= 0) uso.set(i, ETIQUETAS[campo]);
    const desde = a.estructura.desde;
    const muestra = a.filas.slice(desde, desde + 5);
    const tabla = el('table', {},
      el('caption', { texto: 'Las primeras ' + Math.min(5, filasDatos) + ' de ' + plural(filasDatos, 'fila', 'filas') + ' del archivo.' }),
      el('thead', {}, el('tr', {}, a.estructura.titulos.map((t, i) =>
        el('th', { scope: 'col', clase: uso.has(i) ? 'usada' : null }, uso.has(i) ? el('span', { clase: 'uso', texto: uso.get(i) }) : null, t)))),
      el('tbody', {}, muestra.map((fila) => el('tr', {}, a.estructura.titulos.map((t, i) =>
        el('td', { clase: uso.has(i) ? 'usada' : null, texto: valorVista(a, i, fila[i]) }))))));
    hijos.push(el('div', { clase: 'vista-previa' }, tabla));
    caja.replaceChildren(...hijos);
    caja.hidden = false;
  }

  // ------------------------------------------------------------- ejemplo

  function usarEjemplo() {
    const datos = Ejemplo.generar();
    for (const tipo of ['historial', 'existencias', 'plazos']) {
      const { filas, delimitador } = C.leerCSV(datos[tipo]);
      const nombre = Ejemplo.NOMBRES[tipo];
      cargarEnRanura(tipo, { nombre, hojas: [{ nombre, filas }], fecha1904: false, delimitador }, 'ejemplo');
    }
    estado.esEjemplo = true;
    estado.abierto = null;
    $('opcionales').open = true;
  }

  function iniciarEjemplo() {
    $('usar-ejemplo').addEventListener('click', () => {
      usarEjemplo();
      $('estado-carga').replaceChildren('Listo. ', el('a', { href: '#titulo-resultados', texto: 'Vea qué pedir' }), '.');
    });
    for (const boton of document.querySelectorAll('[data-accion="ejemplo"]')) {
      boton.addEventListener('click', () => {
        usarEjemplo();
        $('titulo-resultados').scrollIntoView({ behavior: sinMovimiento() ? 'auto' : 'smooth', block: 'start' });
      });
    }
    for (const boton of document.querySelectorAll('[data-descargar]')) {
      boton.addEventListener('click', () => {
        const tipo = boton.getAttribute('data-descargar');
        descargar(Ejemplo.NOMBRES[tipo], Ejemplo.generar()[tipo]);
      });
    }
  }

  // ---------------------------------------------------------- parámetros

  const CAMPOS_PARAMETROS = ['p-plazo', 'p-nivel', 'p-margen', 'p-costo', 'p-guardar', 'p-lote'];

  function leerParametros() {
    const valor = (id) => C.leerNumero($(id).value);
    const modo = document.querySelector('input[name="modo-nivel"]:checked').value;
    const p = {
      plazo: valor('p-plazo'),
      modoNivel: modo,
      nivel: valor('p-nivel') / 100,
      margen: valor('p-margen'),
      costo: valor('p-costo'),
      tasaGuardar: valor('p-guardar') / 100,
      diasLote: valor('p-lote'),
      ultimosDias: Number($('p-historia').value) || 0
    };
    const errores = {};
    if (!(p.plazo > 0 && p.plazo <= 730)) errores['p-plazo'] = 'Escriba un número de días entre 1 y 730.';
    if (modo === 'fijo' && !(p.nivel >= 0.5 && p.nivel <= 0.999)) errores['p-nivel'] = 'Escriba un porcentaje entre 50 y 99,9.';
    if (modo === 'costos') {
      if (!(p.margen > 0)) errores['p-margen'] = 'Escriba un margen mayor que cero.';
      if (!(p.costo > 0)) errores['p-costo'] = 'Escriba un costo mayor que cero.';
      if (!(p.tasaGuardar >= 0 && p.tasaGuardar <= 2)) errores['p-guardar'] = 'Escriba un porcentaje entre 0 y 200.';
    }
    if (!(p.diasLote >= 1 && p.diasLote <= 365)) errores['p-lote'] = 'Escriba un número de días entre 1 y 365.';
    return { p, errores };
  }

  function pintarErrores(errores) {
    for (const id of CAMPOS_PARAMETROS) {
      const entrada = $(id);
      const idMensaje = 'e-' + id;
      const previo = $(idMensaje);
      const ayuda = entrada.getAttribute('aria-describedby').split(' ').filter((x) => x && x !== idMensaje);
      if (errores[id]) {
        entrada.setAttribute('aria-invalid', 'true');
        const mensaje = previo || el('p', { clase: 'mensaje-error', id: idMensaje });
        mensaje.textContent = errores[id];
        if (!previo) entrada.closest('.con-unidad').after(mensaje);
        entrada.setAttribute('aria-describedby', ayuda.concat(idMensaje).join(' '));
      } else {
        entrada.removeAttribute('aria-invalid');
        if (previo) previo.remove();
        entrada.setAttribute('aria-describedby', ayuda.join(' '));
      }
    }
  }

  function pintarNivelCostos(p) {
    const nodo = $('resultado-nivel');
    if (p.modoNivel !== 'costos' || !(p.margen > 0) || !(p.costo > 0) || !(p.tasaGuardar >= 0) || !(p.diasLote >= 1)) {
      nodo.textContent = '';
      return;
    }
    const guardar = C.guardarDuranteUnLote(p.costo, p.tasaGuardar, p.diasLote);
    const nivel = C.nivelPorCostos(p.margen, guardar);
    const usado = C.acotarNivel(nivel);
    const partes = [
      'Guardar una unidad durante un lote de ' + plural(p.diasLote, 'día', 'días') + ' cuesta ' + dinero(guardar) +
      '; que falte una cuesta ' + dinero(p.margen) + ' de margen.'
    ];
    if (nivel < C.NIVEL_MINIMO) {
      partes.push('Con un margen tan bajo frente a lo que cuesta guardar, la cuenta usa el mínimo: ' + C.formatearNivel(usado) + '.');
    } else if (nivel > C.NIVEL_MAXIMO) {
      partes.push('La cuenta usa el máximo: ' + C.formatearNivel(usado) + '.');
    } else {
      partes.push('Conviene tener producto ' + f(Math.round(usado * 100)) + ' de cada 100 veces: nivel de servicio de ' + C.formatearNivel(usado) + '.');
    }
    const info = estado.preparado ? estado.preparado.info : null;
    if (info) {
      let propios = 0;
      for (const datos of info.values()) if (datos.costo > 0 && (datos.precio > 0 || datos.margen > 0)) propios += 1;
      if (propios) {
        partes.push('Para ' + plural(propios, 'producto', 'productos') + ' con costo y precio en su archivo de existencias, la cuenta usa sus propias cifras.');
      }
    }
    nodo.textContent = partes.join(' ');
  }

  function iniciarParametros() {
    const formulario = $('parametros');
    const actualizarModo = () => {
      const modo = document.querySelector('input[name="modo-nivel"]:checked').value;
      $('modo-fijo').hidden = modo !== 'fijo';
      $('modo-costos').hidden = modo !== 'costos';
    };
    formulario.addEventListener('input', () => {
      actualizarModo();
      programarCalculo(false);
    });
    formulario.addEventListener('change', () => {
      actualizarModo();
      programarCalculo(false);
    });
    formulario.addEventListener('submit', (e) => e.preventDefault());
    actualizarModo();
  }

  // -------------------------------------------------------------- cálculo

  let temporizador = null;

  function programarCalculo(inmediato) {
    clearTimeout(temporizador);
    temporizador = setTimeout(calcular, inmediato ? 0 : 280);
  }

  function preparar() {
    const h = estado.archivos.historial;
    const historial = C.prepararHistorial(h.filas, h.estructura.desde, h.columnas, { delimitador: h.delimitador, fecha1904: h.fecha1904 });
    const lecturas = {};
    for (const tipo of ['existencias', 'plazos']) {
      const a = estado.archivos[tipo];
      if (!a) continue;
      const faltan = C.REQUERIDOS[tipo].filter((c) => !(a.columnas[c] >= 0));
      lecturas[tipo] = faltan.length
        ? { faltan }
        : C.leerPorProducto(a.filas, a.estructura.desde, a.columnas, { delimitador: a.delimitador });
    }
    const info = C.unirPorProducto(lecturas.existencias && lecturas.existencias.porClave, lecturas.plazos && lecturas.plazos.porClave);
    return { version: estado.version, historial, info, lecturas };
  }

  async function calcular() {
    const id = ++estado.calculo;
    const h = estado.archivos.historial;
    const { p, errores } = leerParametros();
    pintarErrores(errores);
    if (!h) {
      estado.preparado = null;
      pintarNivelCostos(p);
      mostrarVacio();
      return;
    }
    const faltan = C.REQUERIDOS.historial.filter((c) => !(h.columnas[c] >= 0));
    if (faltan.length) {
      mostrarVacio('Falta elegir ' + lista(faltan.map((c) => 'la columna de ' + ETIQUETAS[c].toLowerCase())) + ' en su historial.');
      return;
    }
    if (!estado.preparado || estado.preparado.version !== estado.version) estado.preparado = preparar();
    pintarNivelCostos(p);
    if (Object.keys(errores).length) return;
    if (!estado.preparado.historial.dias.length) {
      mostrarVacio('No se encontró ninguna fila con fecha, producto y cantidad válidos. Revise las columnas elegidas.');
      return;
    }

    const contexto = C.prepararCalculo({ historial: estado.preparado.historial, info: estado.preparado.info, parametros: p });
    const total = contexto.universo.length;
    const resultados = new Array(total);
    const marco = $('tabla-marco');
    marco.classList.add('recalculando');
    $('resultados').setAttribute('aria-busy', 'true');
    $('calculando').classList.remove('listo');
    for (let i = 0; i < total; i += TANDA) {
      const fin = Math.min(total, i + TANDA);
      for (let k = i; k < fin; k++) resultados[k] = C.calcularIndice(contexto, k);
      if (total > TANDA) {
        $('calculando').textContent = 'Calculando: ' + Math.round((fin / total) * 100) + ' %';
        await pausa();
        if (id !== estado.calculo) return;
      }
    }
    marco.classList.remove('recalculando');
    $('resultados').removeAttribute('aria-busy');
    estado.contexto = contexto;
    estado.parametros = p;
    estado.resultados = resultados;
    estado.resumen = C.resumir(resultados);
    if (estado.abierto && !resultados.some((r) => r.clave === estado.abierto)) estado.abierto = null;
    pintarResultados();
    const r = estado.resumen;
    $('calculando').classList.add('listo');
    $('calculando').textContent = r.conExistencias
      ? 'Listo: ' + plural(r.pedir, 'producto para pedir', 'productos para pedir') + ' de ' + f(r.total) + '.'
      : 'Listo: ' + plural(r.total, 'producto', 'productos') + '.';
  }

  function mostrarVacio(mensaje) {
    $('resultados').hidden = true;
    const vacio = $('resultados-vacio');
    vacio.hidden = false;
    const p = vacio.querySelector('p');
    p.textContent = mensaje || 'Cuando suba su historial, aquí aparece, producto por producto, cuánto tener y qué pedir hoy.';
    vacio.querySelector('button').hidden = Boolean(mensaje);
    estado.resultados = [];
    estado.contexto = null;
  }

  // ----------------------------------------------------------- resultados

  function nombresDias(cerrados) {
    const nombres = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];
    const orden = [1, 2, 3, 4, 5, 6, 0];
    return orden.filter((d) => cerrados.includes(d)).map((d) => 'los ' + nombres[d]);
  }

  function pintarPeriodo() {
    const s = estado.contexto.series;
    const h = estado.contexto.historial;
    const conVenta = estado.resumen.regulares + estado.resumen.esporadicos;
    const nodo = $('periodo');
    const partes = [];
    if (estado.esEjemplo) partes.push(el('strong', { texto: 'Datos de ejemplo de una empresa ficticia. ' }));
    partes.push('Historia del ' + C.fechaCorta(s.inicio) + ' al ' + C.fechaCorta(s.fin) + ': ' + plural(s.diasCalendario, 'día', 'días') +
      ', ' + plural(h.cuenta.usadas, 'fila', 'filas') + ' y ' + plural(conVenta, 'producto con venta', 'productos con venta') + '.');
    if (s.cerrados.length) {
      partes.push(' No hubo ventas ' + lista(nombresDias(s.cerrados), 'ni') + ': la cuenta usa los ' + f(s.diasTrabajo) +
        ' días de trabajo y pasa el plazo a días de trabajo.');
    }
    nodo.replaceChildren(...partes);
  }

  function ficha(etiqueta, valor, nota, clase) {
    return el('div', { clase: 'ficha' + (clase ? ' ' + clase : '') },
      el('p', { clase: 'ficha-etiqueta', texto: etiqueta }),
      el('span', { clase: 'ficha-valor', texto: valor }),
      nota ? el('p', { clase: 'ficha-nota' }, nota) : null);
  }

  function pintarResumen() {
    const r = estado.resumen;
    const nodo = $('resumen');
    const quietos = r.quietas > 0 ? 'Sin venta en el periodo. Hay ' + cantidad(r.quietas) + ' unidades quietas en bodega.' : 'Sin venta en el periodo.';
    if (r.conExistencias) {
      nodo.replaceChildren(
        ficha('Pedir ya', f(r.pedir), 'Llegaron a su punto de pedido.', 'ficha-pedir'),
        ficha('Están bien', f(r.bien), 'Tienen más que su punto de pedido.'),
        ficha('No se mueven', f(r.sinVenta), quietos));
    } else {
      nodo.replaceChildren(
        ficha('Pedir ya', '—', el('span', {}, 'Falta saber cuántas hay. ', el('button', { type: 'button', clase: 'boton-enlace', texto: 'Suba las existencias de hoy', onclick: abrirExistencias }), '.'), 'ficha-pedir'),
        ficha('Con punto de pedido', f(r.regulares + r.esporadicos), 'Productos con venta en el periodo.'),
        ficha('No se mueven', f(r.sinVenta), quietos));
    }
    $('tipos').textContent = [
      plural(r.regulares, 'se vende casi a diario', 'se venden casi a diario'),
      f(r.esporadicos) + ' de vez en cuando',
      f(r.sinVenta) + ' sin venta'
    ].join(' · ');
  }

  function abrirExistencias() {
    const detalles = $('opcionales');
    detalles.open = true;
    detalles.scrollIntoView({ behavior: sinMovimiento() ? 'auto' : 'smooth', block: 'start' });
    $('archivo-existencias').focus({ preventScroll: true });
  }

  function aviso(texto, importante) {
    return el('li', { clase: importante ? 'importante' : null }, icono(importante ? 'aviso' : 'info'), el('span', { texto }));
  }

  function pintarAvisos() {
    const nodo = $('avisos');
    const avisos = [];
    const s = estado.contexto.series;
    const h = estado.contexto.historial;
    const r = estado.resumen;
    const lecturas = estado.preparado.lecturas;
    if (s.diasCalendario < 60) {
      avisos.push(aviso('Hay solo ' + plural(s.diasCalendario, 'día', 'días') + ' de historia. Con menos de 60, la cuenta es poco confiable: tómela como una primera idea.', true));
    }
    const sinLeer = h.cuenta.sinFecha + h.cuenta.sinCantidad + h.cuenta.sinProducto;
    if (sinLeer) {
      const detalle = [];
      if (h.cuenta.sinFecha) detalle.push(f(h.cuenta.sinFecha) + ' sin fecha válida');
      if (h.cuenta.sinCantidad) detalle.push(f(h.cuenta.sinCantidad) + ' sin cantidad');
      if (h.cuenta.sinProducto) detalle.push(f(h.cuenta.sinProducto) + ' sin producto');
      avisos.push(aviso('No se pudieron leer ' + plural(sinLeer, 'fila', 'filas') + ' del historial: ' + lista(detalle) + '.', sinLeer > h.cuenta.usadas * 0.05));
    }
    if (h.cuenta.devoluciones) avisos.push(aviso('Se dejaron fuera ' + plural(h.cuenta.devoluciones, 'fila', 'filas') + ' con cantidad negativa, que suelen ser devoluciones.'));
    if (h.cuenta.invertidas) avisos.push(aviso('Todas las cantidades venían en negativo: se tomaron como salidas.'));
    if (h.orden === 'mda') avisos.push(aviso('Las fechas se leyeron como mes, día y año, como en Estados Unidos.'));
    if (!estado.esEjemplo) {
      const hoy = Math.floor(Date.now() / 86400000);
      if (hoy - s.fin > 45) avisos.push(aviso('Su historial termina el ' + C.fechaCorta(s.fin) + ', hace ' + f(hoy - s.fin) + ' días. Si la venta cambió desde entonces, la cuenta no lo ve.', true));
    }
    for (const tipo of ['existencias', 'plazos']) {
      const l = lecturas[tipo];
      if (l && l.faltan) avisos.push(aviso('El archivo de ' + tipo + ' no se usa: falta elegir ' + lista(l.faltan.map((c) => 'la columna de ' + ETIQUETAS[c].toLowerCase())) + '.', true));
    }
    const enHistorial = new Set(h.productos.map((p) => p.clave));
    let soloExistencias = 0;
    let soloPlazos = 0;
    for (const [clave, datos] of estado.preparado.info) {
      if (enHistorial.has(clave)) continue;
      if (datos.soloPlazo) soloPlazos += 1;
      else soloExistencias += 1;
    }
    if (soloExistencias) avisos.push(aviso(plural(soloExistencias, 'producto de las existencias no aparece', 'productos de las existencias no aparecen') + ' en el historial: se cuentan como sin venta.'));
    if (soloPlazos) avisos.push(aviso(plural(soloPlazos, 'producto del archivo de plazos no está', 'productos del archivo de plazos no están') + ' en el historial ni en las existencias: no se usan.'));
    if (r.conExistencias && r.sinExistencias) {
      avisos.push(aviso(plural(r.sinExistencias, 'producto no tiene', 'productos no tienen') + ' existencias en su archivo: para ellos se muestra el punto de pedido, sin decir si hay que pedir.'));
    }
    nodo.replaceChildren(...avisos);
    nodo.hidden = !avisos.length;
  }

  // ---------------------------------------------------------------- tabla

  const ORDEN_ESTADO = { pedir: 0, bien: 1, sin_existencias: 2, no_se_pide: 3 };
  const ORDEN_TIPO = { regular: 0, esporadico: 1, sin_venta: 2 };
  const COLUMNAS = [
    { id: 'producto', titulo: 'Producto', valor: (r) => r.producto, texto: true, primero: true },
    { id: 'tipo', titulo: 'Tipo', valor: (r) => ORDEN_TIPO[r.tipo], primero: true },
    { id: 'ventaDiaria', titulo: 'Venta diaria', valor: (r) => r.ventaDiaria, numero: true },
    { id: 'colchon', titulo: 'Colchón', valor: (r) => r.colchon, numero: true },
    { id: 'punto', titulo: 'Punto de pedido', valor: (r) => r.punto, numero: true },
    { id: 'existencias', titulo: 'Existencias', valor: (r) => r.existencias, numero: true },
    { id: 'estado', titulo: 'Pedir ahora', valor: (r) => ORDEN_ESTADO[r.estado], primero: true },
    { id: 'cuanto', titulo: 'Cuánto', valor: (r) => (r.estado === 'pedir' ? r.cuanto : null), numero: true }
  ];
  const ORDENES = [
    ['estado:1', 'Lo que hay que pedir primero'],
    ['cuanto:0', 'Cuánto pedir, de más a menos'],
    ['producto:1', 'Producto, de la A a la Z'],
    ['ventaDiaria:0', 'Venta diaria, de más a menos'],
    ['punto:0', 'Punto de pedido, de más a menos'],
    ['existencias:1', 'Existencias, de menos a más'],
    ['tipo:1', 'Tipo']
  ];

  function comparar(a, b) {
    const col = COLUMNAS.find((c) => c.id === estado.orden.columna);
    const va = col.valor(a);
    const vb = col.valor(b);
    const nulaA = va === null || va === undefined;
    const nulaB = vb === null || vb === undefined;
    if (nulaA !== nulaB) return nulaA ? 1 : -1;
    let d = 0;
    if (!nulaA) {
      if (col.texto) d = String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' });
      else if (va !== vb) d = va < vb ? -1 : 1;
    }
    if (!estado.orden.ascendente) d = -d;
    if (d === 0 && col.id === 'estado') {
      const ua = a.alcanzaDias === null ? Infinity : a.alcanzaDias;
      const ub = b.alcanzaDias === null ? Infinity : b.alcanzaDias;
      if (ua !== ub) d = ua < ub ? -1 : 1;
    }
    if (d === 0) d = String(a.producto).localeCompare(String(b.producto), 'es', { numeric: true, sensitivity: 'base' });
    return d;
  }

  function filtrados() {
    const texto = C.normalizar(estado.filtro.texto);
    return estado.resultados.filter((r) =>
      (estado.filtro.tipo === 'todos' || r.tipo === estado.filtro.tipo) &&
      (!estado.filtro.soloPedir || r.estado === 'pedir') &&
      (!texto || C.normalizar(r.producto + ' ' + r.nombre).includes(texto))).sort(comparar);
  }

  function pintarTitulos() {
    const fila = $('tabla-titulos');
    fila.replaceChildren(...COLUMNAS.map((col) => {
      const activa = estado.orden.columna === col.id;
      return el('th', {
        scope: 'col',
        clase: col.numero ? 'numero' : null,
        'aria-sort': activa ? (estado.orden.ascendente ? 'ascending' : 'descending') : null
      }, el('button', {
        type: 'button',
        onclick: () => {
          if (estado.orden.columna === col.id) estado.orden.ascendente = !estado.orden.ascendente;
          else estado.orden = { columna: col.id, ascendente: Boolean(col.primero) };
          estado.mostrar = PAGINA;
          pintarTitulos();
          pintarCuerpo();
          sincronizarOrden();
        }
      }, el('span', { texto: col.titulo }), el('span', { clase: 'flecha', 'aria-hidden': 'true', texto: activa ? (estado.orden.ascendente ? '↑' : '↓') : '' })));
    }));
  }

  function sincronizarOrden() {
    const valor = estado.orden.columna + ':' + (estado.orden.ascendente ? 1 : 0);
    const select = $('f-orden');
    if ([...select.options].some((o) => o.value === valor)) select.value = valor;
  }

  function celdaEstado(r) {
    if (r.estado === 'pedir') return el('span', { clase: 'estado estado-pedir', texto: 'Pedir ahora' });
    if (r.estado === 'bien') return el('span', { clase: 'estado estado-bien' }, icono('bien'), 'Bien');
    if (r.estado === 'no_se_pide') return el('span', { clase: 'estado estado-no', texto: 'No se pide' });
    return el('span', { clase: 'estado estado-falta', texto: 'Faltan existencias' });
  }

  function filaProducto(r) {
    const abierta = estado.abierto === r.clave;
    const idDetalle = 'detalle-' + estado.resultados.indexOf(r);
    const boton = el('button', {
      type: 'button',
      clase: 'producto-boton',
      'aria-expanded': String(abierta),
      'aria-controls': abierta ? idDetalle : null
    },
    el('span', { clase: 'producto-codigo', texto: r.producto }),
    r.nombre ? el('span', { clase: 'producto-nombre', texto: r.nombre }) : null);
    const existencias = r.existencias === null
      ? '—'
      : [cantidad(r.existencias), r.enCamino > 0 ? el('span', { clase: 'en-camino', texto: '+ ' + cantidad(r.enCamino) + ' en camino' }) : null];
    const fila = el('tr', { clase: 'fila' + (abierta ? ' abierta' : ''), 'data-clave': r.clave },
      el('td', { clase: 'celda-producto' }, boton),
      el('td', { 'data-etiqueta': 'Tipo' }, el('span', { clase: 'tipo', texto: C.TIPOS[r.tipo] })),
      el('td', { clase: 'numero', 'data-etiqueta': 'Venta diaria', texto: r.tipo === 'sin_venta' ? '0' : venta(r.ventaDiaria) }),
      el('td', { clase: 'numero', 'data-etiqueta': 'Colchón', texto: r.tipo === 'sin_venta' ? '—' : cantidad(r.colchon) }),
      el('td', { clase: 'numero', 'data-etiqueta': 'Punto de pedido', texto: r.tipo === 'sin_venta' ? '—' : cantidad(r.punto) }),
      el('td', { clase: 'numero', 'data-etiqueta': 'Existencias' }, existencias),
      el('td', { clase: 'celda-estado' }, celdaEstado(r)),
      el('td', {
        clase: 'numero celda-cuanto' + (r.estado === 'pedir' ? '' : ' vacia'),
        'data-etiqueta': 'Cuánto pedir'
      }, r.estado === 'pedir' ? el('span', { clase: 'cuanto-pedir', texto: cantidad(r.cuanto) }) : ''));
    fila.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      alternarDetalle(r.clave);
    });
    return fila;
  }

  function pintarCuerpo() {
    const lista = filtrados();
    const cuerpo = $('tabla-cuerpo');
    estado.graficos = [];
    const filas = [];
    for (const r of lista.slice(0, estado.mostrar)) {
      filas.push(filaProducto(r));
      if (estado.abierto === r.clave) filas.push(filaDetalle(r));
    }
    cuerpo.replaceChildren(...filas);
    const pie = $('tabla-pie');
    const partes = ['Se muestran ' + f(Math.min(lista.length, estado.mostrar)) + ' de ' + plural(estado.resultados.length, 'producto', 'productos') + '.'];
    if (lista.length !== estado.resultados.length) partes.push(' ' + f(lista.length) + ' cumplen el filtro.');
    pie.replaceChildren(partes.join(''));
    if (lista.length > estado.mostrar) {
      pie.append(' ', el('button', {
        type: 'button',
        clase: 'boton-enlace',
        texto: 'Mostrar ' + f(Math.min(PAGINA, lista.length - estado.mostrar)) + ' más',
        onclick: () => {
          estado.mostrar += PAGINA;
          pintarCuerpo();
        }
      }));
    }
    $('descargar-resultados').disabled = lista.length === 0;
    if (estado.graficos.length) requestAnimationFrame(() => estado.graficos.forEach((g) => g()));
  }

  function alternarDetalle(clave) {
    estado.abierto = estado.abierto === clave ? null : clave;
    pintarCuerpo();
    for (const fila of document.querySelectorAll('#tabla-cuerpo tr.fila')) {
      if (fila.getAttribute('data-clave') === clave) {
        fila.querySelector('.producto-boton').focus({ preventScroll: true });
        break;
      }
    }
  }

  function pintarResultados() {
    $('resultados-vacio').hidden = true;
    $('resultados').hidden = false;
    pintarPeriodo();
    pintarResumen();
    pintarAvisos();
    pintarTitulos();
    sincronizarOrden();
    pintarCuerpo();
  }

  function iniciarFiltros() {
    $('f-orden').replaceChildren(...ORDENES.map(([valor, texto]) => el('option', { value: valor, texto })));
    $('f-orden').addEventListener('change', (e) => {
      const [columna, ascendente] = e.target.value.split(':');
      estado.orden = { columna, ascendente: ascendente === '1' };
      estado.mostrar = PAGINA;
      pintarTitulos();
      pintarCuerpo();
    });
    $('f-texto').addEventListener('input', (e) => {
      estado.filtro.texto = e.target.value;
      estado.mostrar = PAGINA;
      pintarCuerpo();
    });
    $('f-tipo').addEventListener('change', (e) => {
      estado.filtro.tipo = e.target.value;
      estado.mostrar = PAGINA;
      pintarCuerpo();
    });
    $('f-pedir').addEventListener('change', (e) => {
      estado.filtro.soloPedir = e.target.checked;
      estado.mostrar = PAGINA;
      pintarCuerpo();
    });
    $('descargar-resultados').addEventListener('click', () => {
      const decimal = (1.5).toLocaleString().includes(',') ? ',' : '.';
      const hoy = C.fechaISO(Math.floor(Date.now() / 86400000));
      descargar('cuanto-pedir-' + hoy + '.csv', C.resultadosCSV(filtrados(), { decimal }));
    });
    $('imprimir').addEventListener('click', () => window.print());
  }

  // ------------------------------------------------------------- detalle

  function lecturaDetalle(r, s) {
    if (r.tipo === 'sin_venta') {
      return 'No se vendió en los ' + f(s.diasCalendario) + ' días del historial. No se pide.' +
        (r.existencias > 0 ? ' Hay ' + cantidad(r.existencias) + ' en bodega: dinero quieto.' : '');
    }
    if (r.tipo === 'regular') {
      const trabajo = s.factor < 0.999 ? ' (' + venta(r.ventaDiariaTrabajo) + ' por día de trabajo)' : '';
      return 'Se vende casi a diario: ' + venta(r.ventaDiaria) + ' al día en promedio' + trabajo +
        '. De un día a otro, la venta se aparta de ese promedio en ' + venta(r.desviacion) + ', su desviación.';
    }
    return 'Se vende de vez en cuando: sale cada ' + f(r.cadaCuantosDias, 1) + ' días y, cuando sale, salen ' +
      f(r.cuantasCuandoSale, 1) + '. Por eso el punto de pedido sale de repetir la historia y no del promedio.';
  }

  function filaCuenta(etiqueta, valor, total) {
    return [el('dt', { clase: total ? 'total' : null, texto: etiqueta }), el('dd', { clase: total ? 'total' : null, texto: valor })];
  }

  function cuentaDetalle(r, s) {
    const plazo = f(r.plazo, Number.isInteger(r.plazo) ? 0 : 1) + ' días';
    const filas = [];
    filas.push(filaCuenta(r.origenPlazo === 'archivo' ? 'Plazo, según su archivo' : 'Plazo', plazo));
    if (s.factor < 0.999) filas.push(filaCuenta('En días de trabajo', f(r.plazoEfectivo, 1)));
    filas.push(filaCuenta(r.origenNivel === 'archivo' ? 'Nivel de servicio, con sus costos' : 'Nivel de servicio', C.formatearNivel(r.nivel)));
    filas.push(filaCuenta('Venta de la espera', cantidad(r.ventaEspera)));
    filas.push(filaCuenta('Colchón', cantidad(r.colchon)));
    const dl = el('dl', { clase: 'cuenta' }, filas);
    dl.append(...filaCuenta('Punto de pedido', cantidad(r.punto), true));
    return dl;
  }

  function decisionDetalle(r) {
    if (r.estado === 'sin_existencias') return 'Con las existencias de hoy se sabe si hay que pedir.';
    const camino = r.enCamino > 0 ? ' y vienen ' + cantidad(r.enCamino) + ' en camino' : '';
    const tiene = r.existencias > 0 ? 'Hay ' + cantidad(r.existencias) + camino : 'No hay existencias' + camino;
    let alcanza = '';
    if (r.alcanzaDias !== null && r.posicion > 0) {
      alcanza = r.alcanzaDias < 1 ? ' No alcanza para un día.' : ' Alcanza para unos ' + plural(Math.floor(r.alcanzaDias), 'día', 'días') + '.';
    }
    if (r.estado === 'pedir') {
      const falta = C.redondear(r.cuanto - r.lote, r.decimales);
      return tiene + '; el punto de pedido es ' + cantidad(r.punto) + '. Pida ' + cantidad(r.cuanto) + ' ahora: un lote de ' +
        cantidad(r.lote) + (falta > 0 ? ' más ' + cantidad(falta) + ' que faltan para volver al punto' : '') + '.' + alcanza;
    }
    return tiene + ': ' + cantidad(r.posicion - r.punto) + ' por encima del punto de pedido. Cuando baje a ' +
      cantidad(r.punto) + ', pida ' + cantidad(r.lote) + '.' + alcanza;
  }

  function filaDetalle(r) {
    const s = estado.contexto.series;
    const idDetalle = 'detalle-' + estado.resultados.indexOf(r);
    const columnas = [el('div', {}, cuentaDetalle(r, s), r.tipo === 'sin_venta' ? null : el('p', { clase: 'decision', texto: decisionDetalle(r) }))];
    if (r.tipo !== 'sin_venta') {
      const serie = s.series[r.indiceSerie];
      const cajaVenta = el('div', { clase: 'lienzo' });
      const cajaEspera = el('div', { clase: 'lienzo' });
      const pieEspera = el('p', { clase: 'pie-grafico' });
      columnas.push(el('figure', { clase: 'grafico' },
        el('h4', { texto: s.factor < 0.999 ? 'Venta de cada día de trabajo' : 'Venta de cada día' }),
        el('p', {
          clase: 'sub',
          texto: 'Del ' + C.fechaCorta(s.inicio) + ' al ' + C.fechaCorta(s.fin) + '. La raya es el promedio: ' +
            venta(r.ventaDiariaTrabajo) + (s.factor < 0.999 ? ' por día de trabajo.' : ' por día.')
        }),
        cajaVenta));
      columnas.push(el('figure', { clase: 'grafico' },
        el('h4', { texto: 'Lo que se vende en una espera de ' + f(r.plazo, Number.isInteger(r.plazo) ? 0 : 1) + ' días' }),
        el('p', { clase: 'sub', texto: f(estado.contexto.parametros.veces || C.REMUESTRAS) + ' esperas armadas con días tomados al azar de su historia.' }),
        cajaEspera,
        el('p', { clase: 'clave' }, el('span', { clase: 'cubierta', texto: 'cubiertas por el punto de pedido' }), el('span', { clase: 'descubierta', texto: 'no cubiertas' })),
        pieEspera));
      estado.graficos.push(() => {
        graficoVenta(cajaVenta, serie, s.fechas, r.ventaDiariaTrabajo);
        const sumas = C.esperasDe(estado.contexto, r);
        const cubre = C.cobertura(sumas, r.punto);
        graficoEspera(cajaEspera, sumas, r);
        pieEspera.textContent = 'Con ' + cantidad(r.punto) + ' se cubren ' + f(Math.floor(cubre * 100)) + ' de cada 100 esperas.' +
          (r.tipo === 'regular' ? ' El colchón sale de la fórmula; las esperas repetidas lo comprueban.' : '');
      });
    }
    const cuerpo = el('div', { clase: 'detalle-cuerpo' },
      el('h3', {}, r.producto, r.nombre ? el('span', { clase: 'producto-nombre', texto: r.nombre }) : null),
      el('p', { clase: 'detalle-lectura', texto: lecturaDetalle(r, s) }),
      el('div', { clase: 'detalle-rejilla' }, columnas));
    return el('tr', { clase: 'detalle', id: idDetalle }, el('td', { colspan: String(COLUMNAS.length) }, cuerpo));
  }

  // ------------------------------------------------------------ gráficos

  function topeLindo(maximo) {
    if (!(maximo > 0)) return 1;
    const potencia = 10 ** Math.floor(Math.log10(maximo));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * potencia >= maximo) return m * potencia;
    return 10 * potencia;
  }

  /** Un globo que sigue al puntero o al teclado; lo que dice también está en el texto del detalle. */
  function crearGlobo(caja) {
    const globo = el('div', { clase: 'globo', 'aria-hidden': 'true' });
    globo.hidden = true;
    caja.append(globo);
    return {
      mostrar(x, y, ...contenido) {
        globo.replaceChildren(...contenido);
        globo.hidden = false;
        const ancho = caja.clientWidth;
        const medio = globo.offsetWidth / 2;
        globo.style.left = Math.min(Math.max(x, medio), ancho - medio) + 'px';
        globo.style.top = y + 'px';
      },
      ocultar() {
        globo.hidden = true;
      }
    };
  }

  /**
   * Interacción común: el puntero o las flechas del teclado eligen una barra,
   * que se resalta, y el globo dice su valor.
   */
  function hacerInteractivo(lienzo, caja, barras, describir, xDe) {
    const globo = crearGlobo(caja);
    let actual = -1;
    const elegir = (i) => {
      if (actual >= 0 && barras[actual]) barras[actual].nodo.classList.remove('activa');
      actual = i;
      if (i < 0 || !barras[i]) {
        globo.ocultar();
        return;
      }
      barras[i].nodo.classList.add('activa');
      globo.mostrar(xDe(i), barras[i].arriba, ...describir(i));
    };
    lienzo.addEventListener('pointermove', (e) => {
      const caja2 = lienzo.getBoundingClientRect();
      const x = e.clientX - caja2.left;
      let mejor = -1;
      let distancia = Infinity;
      barras.forEach((b, i) => {
        const d = Math.abs(xDe(i) - x);
        if (d < distancia) {
          distancia = d;
          mejor = i;
        }
      });
      elegir(mejor);
    });
    lienzo.addEventListener('pointerleave', () => elegir(-1));
    lienzo.addEventListener('blur', () => elegir(-1));
    lienzo.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      let i = actual < 0 ? barras.length - 1 : actual;
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      if (e.key === 'ArrowRight') i = Math.min(barras.length - 1, i + 1);
      if (e.key === 'Home') i = 0;
      if (e.key === 'End') i = barras.length - 1;
      elegir(i);
    });
  }

  function graficoVenta(caja, serie, fechas, media) {
    caja.replaceChildren();
    const ancho = Math.max(240, Math.floor(caja.clientWidth));
    const alto = 160;
    const m = { izq: 34, der: 8, arr: 16, aba: 26 };
    const w = ancho - m.izq - m.der;
    const h = alto - m.arr - m.aba;
    let maximo = 0;
    for (let i = 0; i < serie.length; i++) if (serie[i] > maximo) maximo = serie[i];
    const tope = topeLindo(Math.max(maximo, media));
    const n = serie.length;
    const paso = w / n;
    const grosor = paso >= 6 ? Math.min(24, paso - 2) : paso >= 3 ? paso - 1 : paso;
    const y = (v) => m.arr + h - (v / tope) * h;
    const lienzo = svg('svg', {
      width: ancho, height: alto, viewBox: '0 0 ' + ancho + ' ' + alto, tabindex: '0', role: 'img',
      'aria-label': 'Venta de cada día: promedio ' + venta(media) + ', máximo ' + cantidad(maximo) + ' en un día.'
    });
    for (const t of [0, tope / 2, tope]) {
      lienzo.append(svg('line', { clase: t === 0 ? 'eje' : 'reticula', x1: m.izq, x2: ancho - m.der, y1: y(t), y2: y(t) }));
      lienzo.append(svg('text', { clase: 'texto-eje', x: m.izq - 6, y: y(t) + 4, 'text-anchor': 'end', texto: f(t, t < 10 && !Number.isInteger(t) ? 1 : 0) }));
    }
    const barras = [];
    for (let i = 0; i < n; i++) {
      const v = serie[i];
      const x = m.izq + i * paso + (paso - grosor) / 2;
      const alto2 = Math.max(0, y(0) - y(v));
      const nodo = svg('rect', { clase: 'barra-venta', x: x.toFixed(2), y: (y(0) - alto2).toFixed(2), width: grosor.toFixed(2), height: alto2.toFixed(2) });
      lienzo.append(nodo);
      barras.push({ nodo, arriba: y(v) });
    }
    lienzo.append(svg('line', { clase: 'linea-media', x1: m.izq, x2: ancho - m.der, y1: y(media), y2: y(media) }));
    const marcas = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : [0];
    marcas.forEach((i, k) => {
      const anchor = k === 0 ? 'start' : k === marcas.length - 1 ? 'end' : 'middle';
      const x = k === 0 ? m.izq : k === marcas.length - 1 ? ancho - m.der : m.izq + (i + 0.5) * paso;
      lienzo.append(svg('text', { clase: 'texto-eje', x, y: alto - 6, 'text-anchor': anchor, texto: C.fechaSinAnio(fechas[i]) }));
    });
    caja.append(lienzo);
    hacerInteractivo(lienzo, caja, barras,
      (i) => [el('strong', { texto: cantidad(serie[i]) }), ' el ' + C.nombreDia(fechas[i]) + ' ' + C.fechaCorta(fechas[i])],
      (i) => m.izq + (i + 0.5) * paso);
  }

  function graficoEspera(caja, sumas, r) {
    caja.replaceChildren();
    const ancho = Math.max(240, Math.floor(caja.clientWidth));
    const alto = 180;
    const m = { izq: 34, der: 8, arr: 34, aba: 26 };
    const w = ancho - m.izq - m.der;
    const h = alto - m.arr - m.aba;
    const histo = C.histograma(sumas, ancho < 420 ? 24 : 40);
    const barrasDatos = histo.barras;
    const total = sumas.length;
    const desde = barrasDatos[0].desde;
    const hasta = histo.enteros ? barrasDatos[barrasDatos.length - 1].hasta + 1 : barrasDatos[barrasDatos.length - 1].hasta;
    const rango = Math.max(hasta - desde, 1e-9);
    const xValor = (v) => m.izq + ((v - desde) / rango) * w;
    let maximo = 0;
    for (const b of barrasDatos) if (b.cuenta > maximo) maximo = b.cuenta;
    const topePct = topeLindo((maximo / total) * 100);
    const y = (cuenta) => m.arr + h - ((cuenta / total) * 100 / topePct) * h;
    const lienzo = svg('svg', {
      width: ancho, height: alto, viewBox: '0 0 ' + ancho + ' ' + alto, tabindex: '0', role: 'img',
      'aria-label': 'Lo vendido en ' + f(total) + ' esperas repetidas: de ' + cantidad(sumas[0]) + ' a ' + cantidad(sumas[total - 1]) +
        '. El punto de pedido, ' + cantidad(r.punto) + ', cubre ' + f(Math.floor(C.cobertura(sumas, r.punto) * 100)) + ' de cada 100.'
    });
    for (const t of [0, topePct / 2, topePct]) {
      const yy = m.arr + h - (t / topePct) * h;
      lienzo.append(svg('line', { clase: t === 0 ? 'eje' : 'reticula', x1: m.izq, x2: ancho - m.der, y1: yy, y2: yy }));
      lienzo.append(svg('text', { clase: 'texto-eje', x: m.izq - 6, y: yy + 4, 'text-anchor': 'end', texto: f(t, Number.isInteger(t) ? 0 : 1) + '%' }));
    }
    const anchoBarra = (histo.ancho / rango) * w;
    const hueco = anchoBarra >= 6 ? 2 : anchoBarra >= 3 ? 1 : 0;
    const barras = [];
    barrasDatos.forEach((b) => {
      const x = xValor(b.desde) + hueco / 2;
      const cubierta = b.desde <= r.punto + 1e-9;
      const nodo = svg('rect', {
        clase: cubierta ? 'barra-cubierta' : 'barra-descubierta',
        x: x.toFixed(2), y: y(b.cuenta).toFixed(2),
        width: Math.max(0.5, anchoBarra - hueco).toFixed(2), height: Math.max(0, y(0) - y(b.cuenta)).toFixed(2)
      });
      lienzo.append(nodo);
      barras.push({ nodo, arriba: y(b.cuenta), b });
    });
    // La raya del punto de pedido, justo después de la barra que lo contiene.
    const xPunto = histo.enteros ? xValor(r.punto + 1) - hueco / 2 : xValor(r.punto);
    const xMedia = histo.enteros ? xValor(r.ventaEspera + 0.5) : xValor(r.ventaEspera);
    const dentro = (x) => x >= m.izq - 1 && x <= ancho - m.der + 1;
    if (dentro(xMedia) && Math.abs(xPunto - xMedia) > 3) {
      lienzo.append(svg('line', { clase: 'linea-media', x1: xMedia, x2: xMedia, y1: m.arr - 4, y2: y(0) }));
    }
    if (dentro(xPunto)) {
      lienzo.append(svg('line', { clase: 'linea-punto', x1: xPunto, x2: xPunto, y1: m.arr - 22, y2: y(0) }));
      const textoPunto = 'punto de pedido ' + cantidad(r.punto);
      const derecha = xPunto + 6 + textoPunto.length * 6.9 > ancho;
      lienzo.append(svg('text', {
        clase: 'texto-marca', x: xPunto + (derecha ? -6 : 6), y: m.arr - 12, 'text-anchor': derecha ? 'end' : 'start',
        texto: textoPunto
      }));
      if (dentro(xMedia) && xPunto - xMedia > 46) {
        const yy = m.arr + 2;
        lienzo.append(svg('path', { clase: 'llave', d: 'M' + xMedia + ' ' + (yy + 4) + 'V' + yy + 'H' + xPunto + 'V' + (yy + 4) }));
        lienzo.append(svg('text', { clase: 'texto-eje', x: (xMedia + xPunto) / 2, y: yy + 14, 'text-anchor': 'middle', texto: 'colchón' }));
      }
    }
    // Etiquetas del eje: los extremos siempre; el promedio, solo si no choca con ellos.
    const letra = 6.7;
    const textoDesde = cantidad(desde);
    const textoHasta = cantidad(histo.enteros ? hasta - 1 : hasta);
    lienzo.append(svg('text', { clase: 'texto-eje', x: m.izq, y: alto - 6, 'text-anchor': 'start', texto: textoDesde }));
    lienzo.append(svg('text', { clase: 'texto-eje', x: ancho - m.der, y: alto - 6, 'text-anchor': 'end', texto: textoHasta }));
    const textoMedia = 'promedio ' + cantidad(r.ventaEspera);
    const mitad = (textoMedia.length * letra) / 2;
    if (dentro(xMedia) && xMedia - mitad > m.izq + textoDesde.length * letra + 10 && xMedia + mitad < ancho - m.der - textoHasta.length * letra - 10) {
      lienzo.append(svg('text', { clase: 'texto-eje', x: xMedia, y: alto - 6, 'text-anchor': 'middle', texto: textoMedia }));
    }
    caja.append(lienzo);
    hacerInteractivo(lienzo, caja, barras, (i) => {
      const b = barras[i].b;
      const rangoTexto = histo.enteros
        ? (b.desde === b.hasta ? cantidad(b.desde) : 'de ' + cantidad(b.desde) + ' a ' + cantidad(b.hasta))
        : 'de ' + cantidad(b.desde) + ' a ' + cantidad(b.hasta);
      return [el('strong', { texto: f(b.cuenta) }), ' de ' + f(total) + ' esperas: se vendieron ' + rangoTexto];
    }, (i) => xValor(barras[i].b.desde) + anchoBarra / 2);
  }

  function redibujarGraficos() {
    if (estado.graficos.length) estado.graficos.forEach((g) => g());
  }

  // ---------------------------------------------------------------- inicio

  function iniciar() {
    iniciarTema();
    iniciarRanuras();
    iniciarEjemplo();
    iniciarParametros();
    iniciarFiltros();
    dibujarSierra(true);
    let ancho = window.innerWidth;
    let espera = null;
    window.addEventListener('resize', () => {
      clearTimeout(espera);
      espera = setTimeout(() => {
        if (window.innerWidth === ancho) return;
        ancho = window.innerWidth;
        dibujarSierra(false);
        redibujarGraficos();
      }, 150);
    });
    programarCalculo(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
