/*
 * Cuánto pedir: la cuenta, sin pantalla.
 *
 * Aquí vive todo lo que no toca la página: leer el archivo (separadores,
 * fechas, decimales y nombres de columna), armar la venta de cada día de cada
 * producto y calcular, producto por producto, cuánto tener y cuándo pedir.
 * El mismo archivo corre en el navegador (como window.Calculo) y en Node, que
 * es donde se prueba con `node --test`.
 *
 * El método, en corto:
 *
 * - Un producto sin ventas en el periodo no se pide.
 * - Si entre un día con venta y el siguiente pasan en promedio más de 1,32
 *   días, la venta es esporádica; si no, es regular.
 * - Regular: la venta de la espera es la venta diaria por los días de plazo.
 *   El colchón crece con lo irregular de la venta (su desviación) y con lo que
 *   tarda el proveedor (la raíz de los días de plazo):
 *   colchón = z x desviación x raíz(plazo), redondeado hacia arriba, donde z es
 *   el factor de la curva normal que cubre el nivel de servicio (1,645 al 95 %).
 *   Punto de pedido = venta de la espera + colchón.
 * - Esporádico: el promedio engaña, así que se repite la historia. Se toman al
 *   azar tantos días del historial como dura la espera y se suman; eso se hace
 *   5.000 veces con semilla fija, y el punto de pedido es la cifra que cubre el
 *   nivel de servicio en esas esperas repetidas.
 * - El nivel de servicio puede salir de los costos: conviene tener producto
 *   mientras guardar una unidad durante un lote cueste menos que el margen que
 *   se pierde si falta. Nivel = 1 - (guardar una unidad durante un lote / margen).
 * - Se pide cuando existencias + lo que viene en camino <= punto de pedido, y
 *   se pide un lote más lo que falte para volver al punto.
 * - Si la empresa no vende ciertos días de la semana (sábados y domingos, por
 *   ejemplo), esos días no cuentan como días sin venta: la cuenta trabaja en
 *   días de trabajo y convierte el plazo a días de trabajo.
 */
(function (raiz, fabrica) {
  'use strict';
  var modulo = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = modulo;
  else raiz.Calculo = modulo;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CORTE_ESPORADICO = 1.32; // intervalo medio entre días con venta desde el cual la venta es esporádica
  const REMUESTRAS = 5000;       // esperas repetidas por producto esporádico
  const SEMILLA = 1777;          // semilla fija: la misma entrada da siempre el mismo resultado
  const NIVEL_MINIMO = 0.5;
  const NIVEL_MAXIMO = 0.999;
  const DIA_MS = 86400000;
  const DIAS_ANIO = 365;

  // ------------------------------------------------------------------ texto

  /** Minúsculas, sin tildes ni signos: "Producto/Referencia interna" -> "producto referencia interna". */
  function normalizar(texto) {
    return String(texto == null ? '' : texto)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /** Separa "[PT-001] Paracetamol" en código y nombre, como lo exporta Odoo. */
  function separarCodigo(valor) {
    const s = String(valor == null ? '' : valor).trim().replace(/\s+/g, ' ');
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(s);
    if (m) return { codigo: m[1].trim(), nombre: m[2].trim() };
    return { codigo: s, nombre: '' };
  }

  /** La clave con la que se cruzan los archivos: sin espacios de más, en mayúsculas y sin ceros a la izquierda. */
  function claveProducto(valor) {
    let s = separarCodigo(valor).codigo.toUpperCase();
    if (/^\d+(\.0+)?$/.test(s)) s = s.replace(/\.0+$/, '').replace(/^0+(?=\d)/, '');
    return s;
  }

  // ---------------------------------------------------------------- números

  function adivinarDecimal(s) {
    const coma = s.lastIndexOf(',');
    const punto = s.lastIndexOf('.');
    if (coma >= 0 && punto >= 0) return coma > punto ? ',' : '.';
    if (coma >= 0) return /^[-+]?\d{1,3}(,\d{3})+$/.test(s) ? '.' : ',';
    return '.';
  }

  /**
   * Lee un número escrito a mano o exportado: "1.234,5", "1,234.5", "2,40",
   * "(5)", "USD 3", "25 %". `decimal` es "," o "."; si no se da, se adivina.
   */
  function leerNumero(valor, decimal) {
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : NaN;
    if (valor == null || typeof valor === 'boolean') return NaN;
    let s = String(valor).trim();
    if (!s) return NaN;
    let negativo = false;
    if (/^\(.*\)$/.test(s)) {
      negativo = true;
      s = s.slice(1, -1);
    }
    s = s.replace(/[\s  ']/g, '')
      .replace(/^(us\$|usd|\$|€)/i, '')
      .replace(/(us\$|usd|\$|€|%)$/i, '');
    if (s.endsWith('-')) s = '-' + s.slice(0, -1);
    const separador = decimal || adivinarDecimal(s);
    s = separador === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    const n = Number(s);
    return negativo ? -n : n;
  }

  /**
   * Decide si una columna usa coma o punto decimal mirando sus valores. Las
   * cifras ambiguas ("1.234") no votan; si nadie vota, manda el separador del
   * archivo: con punto y coma, la coma suele ser decimal.
   */
  function detectarDecimal(valores, delimitador) {
    let coma = 0;
    let punto = 0;
    for (const v of valores) {
      if (typeof v !== 'string') continue;
      const s = v.trim().replace(/[\s  ]/g, '').replace(/^[-+(]|\)$/g, '');
      if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s)) coma += 5;
      else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s)) punto += 5;
      else if (/^\d*,\d+$/.test(s) && !/^\d{1,3},\d{3}$/.test(s)) coma += 1;
      else if (/^\d*\.\d+$/.test(s) && !/^\d{1,3}\.\d{3}$/.test(s)) punto += 1;
      else if (/^\d{1,3}(\.\d{3}){2,}$/.test(s)) coma += 2;
      else if (/^\d{1,3}(,\d{3}){2,}$/.test(s)) punto += 2;
    }
    if (coma > punto) return ',';
    if (punto > coma) return '.';
    return delimitador === ';' ? ',' : '.';
  }

  /** Cuántos decimales usa una lista de cantidades (0 a 3). */
  function contarDecimales(numeros) {
    let d = 0;
    for (const x of numeros) {
      while (d < 3 && Math.abs(x * 10 ** d - Math.round(x * 10 ** d)) > 1e-6) d += 1;
      if (d === 3) break;
    }
    return d;
  }

  function redondear(x, decimales = 0) {
    const p = 10 ** decimales;
    return Math.round(x * p) / p || 0;
  }

  /** Redondea hacia arriba sin que el ruido de la coma flotante (11,0000000001) sume una unidad. */
  function redondearArriba(x, decimales = 0) {
    const p = 10 ** decimales;
    return Math.ceil(x * p - 1e-7) / p || 0;
  }

  /** "1.234,5" con punto de miles y coma decimal. */
  function formatear(numero, decimales = 0) {
    if (numero == null || !Number.isFinite(numero)) return '—';
    const fijo = Math.abs(numero).toFixed(decimales);
    const partes = fijo.split('.');
    const entero = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const signo = numero < 0 && Number(fijo) !== 0 ? '−' : '';
    return signo + entero + (partes[1] ? ',' + partes[1] : '');
  }

  /** 0,95 -> "95 %"; 0,9507 -> "95,1 %". */
  function formatearNivel(nivel) {
    const pct = Math.round(nivel * 1000) / 10;
    return formatear(pct, Number.isInteger(pct) ? 0 : 1) + ' %';
  }

  /** Decimales para mostrar una venta diaria: 0,07 / 4,0 / 128. */
  function decimalesVenta(x) {
    if (x < 1) return 2;
    if (x < 100) return 1;
    return 0;
  }

  // ----------------------------------------------------------------- fechas

  const MESES = {
    ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7,
    ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12
  };
  const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  /** Días desde el 1 de enero de 1970; NaN si la fecha no existe (31 de febrero). */
  function diaDeFecha(anio, mes, dia) {
    if (anio < 100) anio += anio < 70 ? 2000 : 1900;
    if (!(mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31)) return NaN;
    const t = Date.UTC(anio, mes - 1, dia);
    const f = new Date(t);
    if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) return NaN;
    return Math.round(t / DIA_MS);
  }

  function fechaDeDia(dia) {
    const f = new Date(dia * DIA_MS);
    return { anio: f.getUTCFullYear(), mes: f.getUTCMonth() + 1, dia: f.getUTCDate() };
  }

  /** 0 = domingo ... 6 = sábado. */
  function diaSemana(dia) {
    return (((dia % 7) + 7) % 7 + 4) % 7;
  }

  function dos(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function fechaISO(dia) {
    const f = fechaDeDia(dia);
    return f.anio + '-' + dos(f.mes) + '-' + dos(f.dia);
  }

  /** "6 abr 2026". */
  function fechaCorta(dia) {
    const f = fechaDeDia(dia);
    return f.dia + ' ' + MESES_CORTOS[f.mes - 1] + ' ' + f.anio;
  }

  /** "6 abr". */
  function fechaSinAnio(dia) {
    const f = fechaDeDia(dia);
    return f.dia + ' ' + MESES_CORTOS[f.mes - 1];
  }

  function nombreDia(dia) {
    return DIAS_SEMANA[diaSemana(dia)];
  }

  /** Un número de Excel: 46113 (días desde 1900) o 20260401. */
  function fechaDeNumero(n, opciones) {
    if (!Number.isFinite(n)) return NaN;
    if (Number.isInteger(n) && n >= 19000101 && n <= 21001231) {
      return diaDeFecha(Math.floor(n / 10000), Math.floor(n / 100) % 100, n % 100);
    }
    // Solo fechas creíbles (1990 a 2100): así una cantidad no se confunde con una fecha.
    if (n >= 32874 && n < 73051) return Math.floor(n) - 25569 + (opciones && opciones.fecha1904 ? 1462 : 0);
    return NaN;
  }

  const SEMANA_LARGA = /^(lunes|martes|miercoles|jueves|viernes|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s+/;
  const SEMANA_CORTA = /^(lun|mar|mie|jue|vie|sab|dom|mon|tue|wed|thu|fri|sat|sun)\.?,\s+/;

  /**
   * Lee una fecha en los formatos de siempre: 2026-04-01, 01/04/2026, 1-4-26,
   * 01.04.2026, "1 abr 2026", "1 de abril de 2026", "Apr 1, 2026", 20260401,
   * el número de serie de Excel o un Date. Ignora la hora. `orden` dice si las
   * fechas numéricas son día/mes ("dma", lo de aquí) o mes/día ("mda").
   * Devuelve días desde 1970, o NaN.
   */
  function leerFecha(valor, orden, opciones) {
    if (valor instanceof Date) {
      return isNaN(valor) ? NaN : diaDeFecha(valor.getFullYear(), valor.getMonth() + 1, valor.getDate());
    }
    if (typeof valor === 'number') return fechaDeNumero(valor, opciones);
    let s = String(valor == null ? '' : valor).trim();
    if (!s) return NaN;
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(SEMANA_LARGA, '').replace(SEMANA_CORTA, '');
    let m;
    if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s))) return diaDeFecha(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(s))) {
      return orden === 'mda' ? diaDeFecha(+m[3], +m[1], +m[2]) : diaDeFecha(+m[3], +m[2], +m[1]);
    }
    if ((m = /^(\d{1,2})(?:\s+de)?[\s\-/.]+([a-z]+)\.?(?:\s+del?)?[\s\-/.,]+(\d{4}|\d{2})(?!\d)/.exec(s))) {
      const mes = MESES[m[2].slice(0, 3)];
      return mes ? diaDeFecha(+m[3], mes, +m[1]) : NaN;
    }
    if ((m = /^([a-z]+)\.?[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{4})(?!\d)/.exec(s))) {
      const mes = MESES[m[1].slice(0, 3)];
      return mes ? diaDeFecha(+m[3], mes, +m[2]) : NaN;
    }
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return diaDeFecha(+m[1], +m[2], +m[3]);
    if (/^\d{5}(\.\d+)?$/.test(s)) return fechaDeNumero(Number(s), opciones);
    return NaN;
  }

  /** Mira las fechas numéricas de una columna: si alguna tiene más de 12 en el segundo lugar, son mes/día. */
  function detectarOrdenFecha(valores) {
    let dma = 0;
    let mda = 0;
    for (const v of valores) {
      if (typeof v !== 'string') continue;
      const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?!\d)/.exec(v);
      if (!m) continue;
      if (+m[1] > 12) dma += 1;
      if (+m[2] > 12) mda += 1;
    }
    return mda > dma ? 'mda' : 'dma';
  }

  // -------------------------------------------------------------------- CSV

  function contarFueraDeComillas(linea, caracter) {
    let n = 0;
    let dentro = false;
    for (let i = 0; i < linea.length; i++) {
      const c = linea[i];
      if (c === '"') dentro = !dentro;
      else if (c === caracter && !dentro) n += 1;
    }
    return n;
  }

  /** Elige el separador que aparece el mismo número de veces en cada línea. */
  function detectarDelimitador(texto) {
    const lineas = texto.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 30);
    if (!lineas.length) return ',';
    let mejor = ',';
    let mejorPuntaje = -1;
    for (const c of [';', ',', '\t', '|']) {
      const cuentas = lineas.map((l) => contarFueraDeComillas(l, c));
      const frecuencias = new Map();
      for (const x of cuentas) if (x > 0) frecuencias.set(x, (frecuencias.get(x) || 0) + 1);
      if (!frecuencias.size) continue;
      let moda = 0;
      let veces = 0;
      for (const [x, f] of frecuencias) if (f > veces || (f === veces && x > moda)) { moda = x; veces = f; }
      const puntaje = (veces / lineas.length) * 1000 + Math.min(moda, 50);
      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejor = c;
      }
    }
    return mejor;
  }

  /**
   * Lee un CSV: comillas, comillas dobles escapadas, saltos de línea dentro de
   * un campo, BOM y la línea "sep=;" que pone Excel. Devuelve filas de texto.
   */
  function leerCSV(texto, delimitador) {
    if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
    const sep = /^sep=(.)\r?\n/i.exec(texto);
    if (sep) {
      delimitador = sep[1];
      texto = texto.slice(sep[0].length);
    }
    if (!delimitador) delimitador = detectarDelimitador(texto);
    const filas = [];
    let fila = [];
    let campo = '';
    let enComillas = false;
    let i = 0;
    const n = texto.length;
    while (i < n) {
      const c = texto[i];
      if (enComillas) {
        if (c === '"') {
          if (texto[i + 1] === '"') {
            campo += '"';
            i += 1;
          } else {
            enComillas = false;
          }
        } else {
          campo += c;
        }
      } else if (c === '"' && campo.trim() === '') {
        campo = '';
        enComillas = true;
      } else if (c === delimitador) {
        fila.push(campo);
        campo = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && texto[i + 1] === '\n') i += 1;
        fila.push(campo);
        filas.push(fila);
        fila = [];
        campo = '';
      } else {
        campo += c;
      }
      i += 1;
    }
    if (campo !== '' || fila.length) {
      fila.push(campo);
      filas.push(fila);
    }
    return {
      filas: filas.filter((f) => f.some((x) => String(x).trim() !== '')),
      delimitador
    };
  }

  // --------------------------------------------------------------- columnas

  /** Qué columnas busca cada archivo, y cuáles no pueden faltar. */
  const CAMPOS = {
    historial: ['fecha', 'producto', 'cantidad', 'nombre', 'existencias'],
    existencias: ['producto', 'existencias', 'enCamino', 'nombre', 'plazo', 'costo', 'precio', 'margen'],
    plazos: ['producto', 'plazo', 'nombre']
  };
  const REQUERIDOS = {
    historial: ['fecha', 'producto', 'cantidad'],
    existencias: ['producto', 'existencias'],
    plazos: ['producto', 'plazo']
  };

  // Nombres de columna habituales en Excel, Odoo y SAP Business One, con su peso.
  const SINONIMOS = {
    fecha: [
      ['fecha', 10], ['date', 10], ['fecha de venta', 11], ['fecha venta', 11], ['fecha de factura', 10],
      ['fecha factura', 10], ['fecha de emision', 10], ['fecha emision', 10], ['fecha del movimiento', 10],
      ['fecha movimiento', 10], ['fecha de contabilizacion', 10], ['fecha contable', 10],
      ['fecha de documento', 10], ['fecha documento', 10], ['fecha efectiva', 10], ['fecha de pedido', 9],
      ['fecha programada', 8], ['docdate', 10], ['doc date', 10], ['posting date', 10], ['dia', 7],
      ['day', 6], ['periodo', 4]
    ],
    producto: [
      ['codigo', 10], ['cod', 8], ['sku', 10], ['referencia interna', 11], ['default code', 10],
      ['itemcode', 11], ['item code', 11], ['codigo de articulo', 11], ['codigo articulo', 11],
      ['codigo del producto', 11], ['codigo de producto', 11], ['codigo producto', 11],
      ['numero de articulo', 11], ['product code', 11], ['id producto', 9], ['product id', 9],
      ['articulo', 8], ['producto', 8], ['product', 8], ['item', 6], ['material', 6], ['insumo', 6],
      ['referencia', 4]
    ],
    nombre: [
      ['nombre', 8], ['descripcion', 8], ['description', 8], ['dscription', 9], ['nombre del producto', 10],
      ['nombre de producto', 10], ['nombre producto', 10], ['nombre del articulo', 10],
      ['descripcion del articulo', 10], ['item name', 9], ['itemname', 9], ['product name', 9],
      ['name', 6], ['detalle', 5], ['producto', 5], ['articulo', 4]
    ],
    cantidad: [
      ['cantidad', 10], ['cant', 8], ['qty', 10], ['quantity', 10], ['unidades', 9], ['uds', 8],
      ['und', 7], ['unid', 7], ['cantidad entregada', 11], ['cantidad hecha', 11],
      ['cantidad facturada', 11], ['cantidad vendida', 11], ['unidades vendidas', 11],
      ['cantidad consumida', 11], ['consumo', 8], ['vendido', 7], ['vendidas', 7], ['salidas', 7],
      ['salida', 6], ['product uom qty', 9], ['qty done', 9], ['quantity done', 9],
      ['qty delivered', 10], ['qty invoiced', 10]
    ],
    existencias: [
      ['existencias', 10], ['existencia', 10], ['stock', 9], ['inventario', 7], ['saldo', 7],
      ['disponible', 8], ['a mano', 9], ['cantidad a mano', 13], ['en stock', 10], ['on hand', 10],
      ['onhand', 10], ['qty available', 11], ['quantity on hand', 12], ['cantidad disponible', 12],
      ['stock actual', 11], ['existencias actuales', 11], ['existencia actual', 11],
      ['inventario actual', 11], ['saldo actual', 10], ['existencias hoy', 11]
    ],
    enCamino: [
      ['en camino', 10], ['en transito', 10], ['transito', 8], ['por recibir', 10],
      ['pendiente de recibir', 11], ['pedido', 6], ['pedidos', 6], ['onorder', 10], ['on order', 10],
      ['ordenado', 7], ['entrante', 9], ['cantidad entrante', 12], ['incoming', 9], ['incoming qty', 11],
      ['pendiente', 5], ['en pedido', 9]
    ],
    plazo: [
      ['plazo', 10], ['plazo de entrega', 12], ['plazo entrega', 12], ['plazo dias', 12],
      ['dias de plazo', 12], ['lead time', 12], ['leadtime', 12], ['tiempo de entrega', 12],
      ['dias de entrega', 11], ['demora', 8], ['delay', 8], ['dias', 5], ['days', 5]
    ],
    costo: [
      ['costo', 10], ['coste', 10], ['cost', 10], ['costo unitario', 11], ['coste unitario', 11],
      ['standard price', 10], ['precio de costo', 12], ['costo promedio', 11], ['avgprice', 9],
      ['avg price', 9], ['unit cost', 11]
    ],
    precio: [
      ['precio', 9], ['precio de venta', 11], ['precio venta', 11], ['price', 9], ['list price', 10],
      ['sales price', 10], ['pvp', 9], ['precio unitario', 9], ['tarifa', 6], ['unit price', 9]
    ],
    margen: [['margen', 10], ['margin', 10], ['margen unitario', 11], ['utilidad', 6], ['ganancia', 6]]
  };

  // Palabras que delatan otra cosa: "Fecha de vencimiento" no es la fecha de la venta.
  const DESCARTES = {
    fecha: ['vencimiento', 'caducidad', 'expiracion', 'creacion', 'create', 'write', 'modificacion', 'nacimiento'],
    producto: ['cliente', 'customer', 'proveedor', 'vendor', 'vendedor', 'bodega', 'almacen', 'ubicacion',
      'lote', 'serie', 'factura', 'documento', 'pedido', 'orden', 'categoria', 'unidad', 'uom', 'familia',
      'linea', 'marca'],
    nombre: ['cliente', 'customer', 'proveedor', 'vendor', 'vendedor', 'bodega', 'almacen', 'categoria'],
    cantidad: ['precio', 'price', 'valor', 'total', 'monto', 'costo', 'descuento', 'impuesto', 'iva',
      'subtotal', 'pendiente', 'a mano', 'disponible', 'entrante'],
    existencias: ['minimo', 'maximo', 'reorden', 'seguridad', 'pronosticad', 'virtual', 'forecast'],
    enCamino: ['cliente', 'customer', 'fecha', 'numero'],
    plazo: ['pago', 'credito', 'vencimiento'],
    costo: ['total'],
    precio: ['total', 'costo'],
    margen: ['total']
  };

  const PRIORIDAD = {
    fecha: 0, cantidad: 1, producto: 2, existencias: 3, enCamino: 4, plazo: 5, nombre: 6, costo: 7, precio: 8, margen: 9
  };

  function puntajeColumna(normal, campo) {
    if (!normal) return 0;
    const conEspacios = ' ' + normal + ' ';
    let mejor = 0;
    for (const [sinonimo, peso] of SINONIMOS[campo]) {
      let p = 0;
      if (normal === sinonimo) p = peso + 2;
      else if (conEspacios.includes(' ' + sinonimo + ' ')) p = peso;
      if (p > mejor) mejor = p;
    }
    if (mejor > 0 && (DESCARTES[campo] || []).some((d) => conEspacios.includes(' ' + d))) mejor -= 6;
    return mejor;
  }

  /**
   * Reconoce las columnas por su nombre. Devuelve, para cada campo del tipo de
   * archivo, el índice de la columna o -1. Cada columna se usa una sola vez y
   * gana la coincidencia más fuerte: "Cantidad a mano" va a existencias aunque
   * también diga "cantidad".
   */
  function detectarColumnas(encabezados, tipo) {
    const campos = CAMPOS[tipo];
    const normales = encabezados.map(normalizar);
    const candidatos = [];
    for (const campo of campos) {
      for (let i = 0; i < normales.length; i++) {
        const p = puntajeColumna(normales[i], campo);
        if (p >= 4) candidatos.push({ campo, i, p });
      }
    }
    candidatos.sort((a, b) => b.p - a.p || PRIORIDAD[a.campo] - PRIORIDAD[b.campo] || a.i - b.i);
    const columnas = {};
    const usadas = new Set();
    for (const c of candidatos) {
      if (columnas[c.campo] !== undefined || usadas.has(c.i)) continue;
      columnas[c.campo] = c.i;
      usadas.add(c.i);
    }
    for (const campo of campos) if (columnas[campo] === undefined) columnas[campo] = -1;
    // Sin código pero con nombre: el nombre identifica al producto.
    if (columnas.producto === -1 && columnas.nombre !== undefined && columnas.nombre !== -1) {
      columnas.producto = columnas.nombre;
      columnas.nombre = -1;
    }
    return columnas;
  }

  function pareceFecha(v) {
    if (typeof v === 'number') return Number.isFinite(fechaDeNumero(v));
    return Number.isFinite(leerFecha(v, 'dma'));
  }

  function pareceNumero(v) {
    return Number.isFinite(leerNumero(v));
  }

  function muestraColumna(filas, desde, i, limite = 60) {
    const valores = [];
    for (let k = desde; k < filas.length && valores.length < limite; k++) {
      const v = filas[k][i];
      if (v !== undefined && v !== null && String(v).trim() !== '') valores.push(v);
    }
    return valores;
  }

  /**
   * Si a un archivo de historial le falta una columna obligatoria por nombre,
   * la busca por lo que contiene: la que trae fechas, la que trae cantidades y
   * la que trae texto.
   */
  function completarPorContenido(filas, desde, columnas, tipo) {
    const resultado = Object.assign({}, columnas);
    const porContenido = [];
    const ancho = filas.reduce((max, f, k) => (k >= desde && k < desde + 50 ? Math.max(max, f.length) : max), 0);
    const usadas = () => new Set(Object.values(resultado).filter((i) => i >= 0));
    const proporcion = (i, prueba) => {
      const muestra = muestraColumna(filas, desde, i);
      if (muestra.length < 3) return 0;
      return muestra.filter(prueba).length / muestra.length;
    };
    if (tipo === 'historial' && resultado.fecha === -1) {
      for (let i = 0; i < ancho; i++) {
        if (usadas().has(i)) continue;
        if (proporcion(i, (v) => typeof v === 'string' && pareceFecha(v)) >= 0.8) {
          resultado.fecha = i;
          porContenido.push('fecha');
          break;
        }
      }
    }
    if (tipo === 'historial' && resultado.cantidad === -1) {
      for (let i = ancho - 1; i >= 0; i--) {
        if (usadas().has(i)) continue;
        if (proporcion(i, pareceNumero) >= 0.8 && proporcion(i, (v) => typeof v === 'string' && pareceFecha(v)) < 0.5) {
          resultado.cantidad = i;
          porContenido.push('cantidad');
          break;
        }
      }
    }
    if (resultado.producto === -1) {
      for (let i = 0; i < ancho; i++) {
        if (usadas().has(i)) continue;
        if (proporcion(i, (v) => !pareceNumero(v) && !pareceFecha(v)) >= 0.8) {
          resultado.producto = i;
          porContenido.push('producto');
          break;
        }
      }
    }
    return { columnas: resultado, porContenido };
  }

  /**
   * Encuentra la fila de los títulos: algunos informes traen antes un nombre de
   * empresa o un rango de fechas. Si ninguna fila tiene títulos conocidos y la
   * primera ya trae datos, el archivo no tiene títulos (devuelve -1).
   */
  function encontrarEncabezado(filas, tipo) {
    const requeridos = REQUERIDOS[tipo];
    const limite = Math.min(filas.length, 20);
    let mejor = 0;
    let mejorCuenta = 0;
    for (let i = 0; i < limite; i++) {
      const columnas = detectarColumnas(filas[i].map((x) => String(x == null ? '' : x)), tipo);
      const cuenta = requeridos.filter((c) => columnas[c] !== -1).length;
      if (cuenta === requeridos.length) return i;
      if (cuenta > mejorCuenta) {
        mejor = i;
        mejorCuenta = cuenta;
      }
    }
    if (mejorCuenta === 0 && filas.length && filas[0].some((v) => pareceFecha(v) || (typeof v === 'number'))) return -1;
    return mejor;
  }

  /**
   * Todo lo que hace falta para leer un archivo: la fila de títulos, los
   * nombres de columna y la columna de cada campo.
   */
  function leerEstructura(filas, tipo) {
    const encabezado = encontrarEncabezado(filas, tipo);
    const desde = encabezado + 1;
    const ancho = filas.slice(Math.max(0, encabezado), Math.max(0, encabezado) + 50)
      .reduce((max, f) => Math.max(max, f.length), 0);
    const titulos = [];
    for (let i = 0; i < ancho; i++) {
      const t = encabezado >= 0 ? String(filas[encabezado][i] == null ? '' : filas[encabezado][i]).trim() : '';
      titulos.push(t || 'Columna ' + (i + 1));
    }
    const porNombre = encabezado >= 0 ? detectarColumnas(titulos, tipo) : detectarColumnas([], tipo);
    const completado = completarPorContenido(filas, desde, porNombre, tipo);
    return { encabezado, desde, titulos, columnas: completado.columnas, porContenido: completado.porContenido };
  }

  // -------------------------------------------------------- leer el archivo

  /**
   * Convierte las filas del historial en movimientos: día, producto y cantidad.
   * Cuenta lo que no se pudo leer para poder decirlo. Si todas las cantidades
   * vienen en negativo (salidas de un kárdex), las toma en positivo; si solo
   * algunas, las trata como devoluciones y no las cuenta.
   */
  function prepararHistorial(filas, desde, columnas, opciones = {}) {
    const cf = columnas.fecha;
    const cp = columnas.producto;
    const cc = columnas.cantidad;
    const cn = columnas.nombre === undefined ? -1 : columnas.nombre;
    const ce = columnas.existencias === undefined ? -1 : columnas.existencias;
    const muestraFechas = [];
    const muestraNumeros = [];
    for (let k = desde; k < filas.length && muestraFechas.length < 3000; k++) {
      const f = filas[k];
      if (typeof f[cf] === 'string') muestraFechas.push(f[cf]);
      if (typeof f[cc] === 'string') muestraNumeros.push(f[cc]);
      if (ce >= 0 && typeof f[ce] === 'string') muestraNumeros.push(f[ce]);
    }
    const orden = opciones.ordenFecha || detectarOrdenFecha(muestraFechas);
    const decimal = opciones.decimal || detectarDecimal(muestraNumeros, opciones.delimitador);
    const lecturaFecha = { fecha1904: !!opciones.fecha1904 };

    const productos = [];
    const indicePorClave = new Map();
    const dias = [];
    const prods = [];
    const cants = [];
    let negativas = 0;
    const existenciasArchivo = new Map();
    const cuenta = { filas: 0, usadas: 0, sinFecha: 0, sinProducto: 0, sinCantidad: 0, devoluciones: 0, invertidas: false };

    for (let k = desde; k < filas.length; k++) {
      const f = filas[k];
      cuenta.filas += 1;
      const textoProducto = f[cp] == null ? '' : String(f[cp]).trim();
      if (!textoProducto) { cuenta.sinProducto += 1; continue; }
      const dia = leerFecha(f[cf], orden, lecturaFecha);
      if (!Number.isFinite(dia)) { cuenta.sinFecha += 1; continue; }
      const cantidad = leerNumero(f[cc], decimal);
      if (!Number.isFinite(cantidad)) { cuenta.sinCantidad += 1; continue; }
      const clave = claveProducto(textoProducto);
      let indice = indicePorClave.get(clave);
      if (indice === undefined) {
        const partes = separarCodigo(textoProducto);
        const nombre = cn >= 0 && f[cn] != null ? String(f[cn]).trim() : partes.nombre;
        indice = productos.length;
        productos.push({ clave, codigo: partes.codigo, nombre });
        indicePorClave.set(clave, indice);
      } else if (!productos[indice].nombre && cn >= 0 && f[cn] != null && String(f[cn]).trim()) {
        productos[indice].nombre = String(f[cn]).trim();
      }
      if (ce >= 0) {
        const ex = leerNumero(f[ce], decimal);
        const previa = existenciasArchivo.get(clave);
        if (Number.isFinite(ex) && (!previa || dia >= previa.dia)) existenciasArchivo.set(clave, { dia, valor: ex });
      }
      if (cantidad < 0) negativas += 1;
      dias.push(dia);
      prods.push(indice);
      cants.push(cantidad);
    }

    const positivas = cants.filter((c) => c > 0).length;
    if (negativas > 0 && positivas === 0) {
      for (let i = 0; i < cants.length; i++) cants[i] = Math.abs(cants[i]);
      cuenta.invertidas = true;
    } else if (negativas > 0) {
      for (let i = 0; i < cants.length; i++) if (cants[i] < 0) cants[i] = 0;
      cuenta.devoluciones = negativas;
    }
    cuenta.usadas = dias.length - cuenta.devoluciones;
    return {
      productos,
      indicePorClave,
      dias,
      prods,
      cants,
      existenciasArchivo,
      decimales: contarDecimales(cants),
      orden,
      decimal,
      cuenta
    };
  }

  /**
   * Lee un archivo con una fila por producto (existencias o plazos). Devuelve
   * un mapa clave -> { codigo, nombre, existencias, enCamino, plazo, costo, precio, margen }.
   */
  function leerPorProducto(filas, desde, columnas, opciones = {}) {
    const numericos = ['existencias', 'enCamino', 'plazo', 'costo', 'precio', 'margen']
      .filter((c) => columnas[c] !== undefined && columnas[c] >= 0);
    const muestra = [];
    for (let k = desde; k < filas.length && muestra.length < 3000; k++) {
      for (const c of numericos) if (typeof filas[k][columnas[c]] === 'string') muestra.push(filas[k][columnas[c]]);
    }
    const decimal = opciones.decimal || detectarDecimal(muestra, opciones.delimitador);
    const porClave = new Map();
    const cuenta = { filas: 0, usadas: 0, sinProducto: 0, sinValor: 0 };
    for (let k = desde; k < filas.length; k++) {
      const f = filas[k];
      cuenta.filas += 1;
      const texto = f[columnas.producto] == null ? '' : String(f[columnas.producto]).trim();
      if (!texto) { cuenta.sinProducto += 1; continue; }
      const clave = claveProducto(texto);
      const partes = separarCodigo(texto);
      const previo = porClave.get(clave) || { codigo: partes.codigo, nombre: partes.nombre };
      if (columnas.nombre !== undefined && columnas.nombre >= 0 && f[columnas.nombre] != null && String(f[columnas.nombre]).trim()) {
        previo.nombre = String(f[columnas.nombre]).trim();
      }
      let alguno = false;
      for (const c of numericos) {
        const v = leerNumero(f[columnas[c]], decimal);
        if (!Number.isFinite(v)) continue;
        if (c === 'plazo' && !(v > 0)) continue;
        // Varias filas del mismo producto (una por bodega o por lote) se suman.
        if (c === 'existencias' || c === 'enCamino') previo[c] = (previo[c] || 0) + v;
        else previo[c] = v;
        alguno = true;
      }
      if (!alguno) { cuenta.sinValor += 1; continue; }
      porClave.set(clave, previo);
      cuenta.usadas += 1;
    }
    return { porClave, decimal, cuenta };
  }

  // ----------------------------------------------------- la venta de cada día

  /**
   * Arma la venta de cada día de trabajo de cada producto. El periodo va del
   * primer al último día del historial (o los últimos `ultimosDias`). Un día de
   * la semana en que la empresa casi nunca registra movimientos (menos de 1 de
   * cada 10, cuando otros días tienen más de 1 de cada 2) se toma como día
   * cerrado: no cuenta como día sin venta. `factor` es la parte de los días
   * corridos que son de trabajo, para convertir el plazo.
   */
  function construirSeries(historial, opciones = {}) {
    const total = historial.dias.length;
    let fin = -Infinity;
    for (let i = 0; i < total; i++) if (historial.dias[i] > fin) fin = historial.dias[i];
    let inicio = Infinity;
    const corte = opciones.ultimosDias > 0 ? fin - opciones.ultimosDias + 1 : -Infinity;
    for (let i = 0; i < total; i++) {
      const d = historial.dias[i];
      if (d >= corte && d < inicio) inicio = d;
    }
    const cantidadProductos = historial.productos.length;
    if (!Number.isFinite(inicio) || !Number.isFinite(fin)) {
      return {
        inicio: NaN, fin: NaN, diasCalendario: 0, diasTrabajo: 0, factor: 1, cerrados: [], fechas: [],
        series: historial.productos.map(() => new Float64Array(0)), ultimaVenta: new Array(cantidadProductos).fill(null)
      };
    }
    const N = fin - inicio + 1;
    const conMovimiento = new Uint8Array(N);
    for (let i = 0; i < total; i++) {
      const d = historial.dias[i];
      if (d >= inicio && historial.cants[i] > 0) conMovimiento[d - inicio] = 1;
    }
    const veces = [0, 0, 0, 0, 0, 0, 0];
    const activos = [0, 0, 0, 0, 0, 0, 0];
    for (let k = 0; k < N; k++) {
      const s = diaSemana(inicio + k);
      veces[s] += 1;
      if (conMovimiento[k]) activos[s] += 1;
    }
    const tasas = veces.map((v, s) => (v ? activos[s] / v : 0));
    const cerrados = [];
    if (N >= 28 && Math.max(...tasas) >= 0.5) {
      for (let s = 0; s < 7; s++) if (veces[s] >= 4 && tasas[s] < 0.1) cerrados.push(s);
    }
    const indice = new Int32Array(N).fill(-1);
    const fechas = [];
    for (let k = 0; k < N; k++) {
      if (!cerrados.includes(diaSemana(inicio + k)) || conMovimiento[k]) {
        indice[k] = fechas.length;
        fechas.push(inicio + k);
      }
    }
    const n = fechas.length;
    const series = [];
    for (let p = 0; p < cantidadProductos; p++) series.push(new Float64Array(n));
    const ultimaVenta = new Array(cantidadProductos).fill(null);
    for (let i = 0; i < total; i++) {
      const d = historial.dias[i];
      const c = historial.cants[i];
      if (d < inicio || !(c > 0)) continue;
      const p = historial.prods[i];
      series[p][indice[d - inicio]] += c;
      if (ultimaVenta[p] === null || d > ultimaVenta[p]) ultimaVenta[p] = d;
    }
    return { inicio, fin, diasCalendario: N, diasTrabajo: n, factor: n / N, cerrados, fechas, series, ultimaVenta };
  }

  // --------------------------------------------------------------- la cuenta

  function media(serie) {
    let s = 0;
    for (let i = 0; i < serie.length; i++) s += serie[i];
    return serie.length ? s / serie.length : 0;
  }

  /** Desviación de la muestra (dividida entre n - 1). */
  function desviacion(serie, m) {
    const n = serie.length;
    if (n < 2) return 0;
    if (m === undefined) m = media(serie);
    let s = 0;
    for (let i = 0; i < n; i++) {
      const d = serie[i] - m;
      s += d * d;
    }
    return Math.sqrt(s / (n - 1));
  }

  /**
   * Inversa de la normal estándar: el z que deja una probabilidad p a su
   * izquierda (0,95 -> 1,6449). Aproximación racional por tramos, con error
   * relativo menor que 1,2e-9.
   */
  function inversaNormal(p) {
    if (!(p > 0 && p < 1)) {
      if (p === 0) return -Infinity;
      if (p === 1) return Infinity;
      return NaN;
    }
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
      1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
      6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
      -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const bajo = 0.02425;
    if (p < bajo) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - bajo) {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /** Generador de números al azar con semilla: la misma semilla da la misma secuencia. */
  function generador(semilla) {
    let a = semilla >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Un número estable a partir de un texto, para que cada producto tenga su propia semilla. */
  function semillaDe(texto) {
    let h = 0x811c9dc5;
    const s = String(texto);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Repite la espera: toma `plazo` días al azar de la historia y los suma,
   * `veces` veces. Si el plazo tiene fracción (7,1 días de trabajo), el día de
   * más se suma con esa probabilidad.
   */
  function remuestrear(serie, plazo, veces, azar) {
    const n = serie.length;
    const sumas = new Float64Array(veces);
    if (!n) return sumas;
    const enteros = Math.floor(plazo + 1e-9);
    const fraccion = plazo - enteros;
    for (let i = 0; i < veces; i++) {
      let s = 0;
      for (let j = 0; j < enteros; j++) s += serie[Math.floor(azar() * n)];
      if (fraccion > 1e-9 && azar() < fraccion) s += serie[Math.floor(azar() * n)];
      sumas[i] = s;
    }
    return sumas;
  }

  /** El valor de una lista ordenada que deja la proporción q por debajo, tomando el de arriba si cae entre dos. */
  function percentilAlto(ordenadas, q) {
    const n = ordenadas.length;
    if (!n) return 0;
    const k = Math.min(n - 1, Math.max(0, Math.ceil((n - 1) * q - 1e-9)));
    return ordenadas[k];
  }

  /** Sin venta, esporádico o regular, según cada cuántos días se vende. */
  function clasificar(serie) {
    let conVenta = 0;
    let total = 0;
    for (let i = 0; i < serie.length; i++) {
      if (serie[i] > 0) {
        conVenta += 1;
        total += serie[i];
      }
    }
    if (!conVenta) return { tipo: 'sin_venta', diasConVenta: 0, intervalo: Infinity, total: 0 };
    const intervalo = serie.length / conVenta;
    return { tipo: intervalo > CORTE_ESPORADICO ? 'esporadico' : 'regular', diasConVenta: conVenta, intervalo, total };
  }

  /**
   * La cuenta de un producto regular: venta de la espera, colchón y punto de
   * pedido. Con venta 4 al día, desviación 2, plazo 10 y 95 %: 40 + 11 = 51.
   */
  function cuentaRegular({ ventaDiaria, desviacion: sigma, plazo, nivel, decimales = 0 }) {
    const z = inversaNormal(nivel);
    const ventaEspera = redondear(ventaDiaria * plazo, decimales);
    const colchon = Math.max(0, redondearArriba(z * sigma * Math.sqrt(plazo), decimales));
    return { z, ventaEspera, colchon, punto: redondear(ventaEspera + colchon, decimales) };
  }

  /** La cuenta de un producto esporádico: la cifra que cubre el nivel de servicio en las esperas repetidas. */
  function cuentaEsporadica(serie, { plazo, nivel, veces = REMUESTRAS, semilla = SEMILLA, decimales = 0 }) {
    const sumas = remuestrear(serie, plazo, veces, generador(semilla)).sort();
    return { punto: redondear(percentilAlto(sumas, nivel), decimales), sumas };
  }

  /** Lo que cuesta guardar una unidad durante un lote: costo x tasa anual x días del lote / 365. */
  function guardarDuranteUnLote(costo, tasaAnual, diasLote) {
    return costo * tasaAnual * diasLote / DIAS_ANIO;
  }

  /**
   * El nivel de servicio que conviene: 1 - (guardar una unidad durante un lote /
   * margen que se pierde si falta). Con margen 1,00 y guardar 0,05: 0,95.
   */
  function nivelPorCostos(margen, guardarUnLote) {
    if (!(margen > 0) || !(guardarUnLote >= 0)) return NaN;
    return 1 - guardarUnLote / margen;
  }

  function acotarNivel(nivel) {
    if (!Number.isFinite(nivel)) return NIVEL_MINIMO;
    return Math.min(NIVEL_MAXIMO, Math.max(NIVEL_MINIMO, nivel));
  }

  /**
   * Todo lo de un producto a partir de su venta de cada día de trabajo.
   * opciones: plazo (días corridos), factor (días de trabajo / días corridos),
   * diasCalendario, nivel, diasLote, decimales, veces, semilla.
   */
  function calcularProducto(serie, opciones) {
    const factor = opciones.factor > 0 ? opciones.factor : 1;
    const diasCalendario = opciones.diasCalendario || serie.length;
    const decimales = opciones.decimales || 0;
    const diasLote = opciones.diasLote > 0 ? opciones.diasLote : 30;
    const nivel = opciones.nivel;
    const plazo = opciones.plazo;
    const plazoEfectivo = plazo * factor;
    const clase = clasificar(serie);
    const r = {
      tipo: clase.tipo,
      diasConVenta: clase.diasConVenta,
      nivel,
      plazo,
      plazoEfectivo,
      ventaDiaria: 0,
      ventaDiariaTrabajo: 0,
      desviacion: 0,
      cadaCuantosDias: null,
      cuantasCuandoSale: null,
      z: null,
      ventaEspera: 0,
      colchon: 0,
      punto: 0,
      lote: 0
    };
    if (clase.tipo === 'sin_venta') return r;
    const mediaTrabajo = clase.total / serie.length;
    r.ventaDiaria = clase.total / diasCalendario;
    r.ventaDiariaTrabajo = mediaTrabajo;
    r.desviacion = desviacion(serie, mediaTrabajo);
    r.cadaCuantosDias = diasCalendario / clase.diasConVenta;
    r.cuantasCuandoSale = clase.total / clase.diasConVenta;
    r.z = inversaNormal(nivel);
    if (clase.tipo === 'regular') {
      const c = cuentaRegular({ ventaDiaria: mediaTrabajo, desviacion: r.desviacion, plazo: plazoEfectivo, nivel, decimales });
      r.ventaEspera = c.ventaEspera;
      r.colchon = c.colchon;
      r.punto = c.punto;
    } else {
      const c = cuentaEsporadica(serie, {
        plazo: plazoEfectivo, nivel, veces: opciones.veces, semilla: opciones.semilla, decimales
      });
      r.ventaEspera = redondear(mediaTrabajo * plazoEfectivo, decimales);
      r.punto = c.punto;
      r.colchon = Math.max(0, redondear(c.punto - r.ventaEspera, decimales));
    }
    r.lote = Math.max(1 / 10 ** decimales, redondearArriba(r.ventaDiaria * diasLote, decimales));
    return r;
  }

  /**
   * Con las existencias: pedir si existencias + en camino <= punto de pedido, y
   * pedir un lote más lo que falte para volver al punto.
   */
  function decidirPedido(r, existencias, enCamino, decimales = 0) {
    const tieneExistencias = existencias != null && Number.isFinite(existencias);
    if (r.tipo === 'sin_venta') {
      return { estado: 'no_se_pide', cuanto: 0, posicion: tieneExistencias ? existencias + (enCamino || 0) : null };
    }
    if (!tieneExistencias) return { estado: 'sin_existencias', cuanto: null, posicion: null };
    const posicion = existencias + (enCamino || 0);
    if (posicion <= r.punto + 1e-9) {
      return { estado: 'pedir', cuanto: redondearArriba(r.punto + r.lote - posicion, decimales), posicion };
    }
    return { estado: 'bien', cuanto: 0, posicion };
  }

  /**
   * Junta el historial con las existencias y los plazos, y deja listo el
   * cálculo producto por producto (la página lo corre por tandas para no
   * congelar la pantalla).
   *
   * parametros: plazo, modoNivel ("fijo" o "costos"), nivel, margen, costo,
   * tasaGuardar, diasLote, ultimosDias.
   */
  function prepararCalculo({ historial, info, parametros }) {
    const series = construirSeries(historial, { ultimosDias: parametros.ultimosDias });
    const universo = historial.productos.map((p, i) => ({
      clave: p.clave, codigo: p.codigo, nombre: p.nombre, indice: i, enHistorial: true
    }));
    const vistos = new Set(universo.map((u) => u.clave));
    if (info) {
      for (const [clave, datos] of info) {
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        universo.push({ clave, codigo: datos.codigo, nombre: datos.nombre || '', indice: -1, enHistorial: false });
      }
    }
    const guardarGeneral = guardarDuranteUnLote(parametros.costo, parametros.tasaGuardar, parametros.diasLote);
    const nivelGeneral = parametros.modoNivel === 'costos'
      ? acotarNivel(nivelPorCostos(parametros.margen, guardarGeneral))
      : acotarNivel(parametros.nivel);
    return {
      historial, info: info || new Map(), parametros, series, universo, nivelGeneral, guardarGeneral,
      vacia: new Float64Array(series.diasTrabajo)
    };
  }

  function nivelDeProducto(contexto, datos) {
    const p = contexto.parametros;
    if (p.modoNivel !== 'costos' || !datos || !(datos.costo > 0)) return { nivel: contexto.nivelGeneral, origen: 'general' };
    const margen = datos.margen > 0 ? datos.margen : (datos.precio > 0 ? datos.precio - datos.costo : NaN);
    if (!Number.isFinite(margen)) return { nivel: contexto.nivelGeneral, origen: 'general' };
    const nivel = acotarNivel(nivelPorCostos(margen, guardarDuranteUnLote(datos.costo, p.tasaGuardar, p.diasLote)));
    return { nivel, origen: 'archivo' };
  }

  function calcularIndice(contexto, i) {
    const u = contexto.universo[i];
    const p = contexto.parametros;
    const s = contexto.series;
    const datos = contexto.info.get(u.clave);
    const serie = u.indice >= 0 ? s.series[u.indice] : contexto.vacia;
    const plazoArchivo = datos && datos.plazo > 0 ? datos.plazo : null;
    const plazo = plazoArchivo || p.plazo;
    const nivel = nivelDeProducto(contexto, datos);
    const decimales = contexto.historial.decimales;
    const r = calcularProducto(serie, {
      plazo,
      factor: s.factor,
      diasCalendario: s.diasCalendario,
      nivel: nivel.nivel,
      diasLote: p.diasLote,
      decimales,
      veces: p.veces || REMUESTRAS,
      semilla: (SEMILLA ^ semillaDe(u.clave)) >>> 0
    });
    let existencias = datos && Number.isFinite(datos.existencias) ? datos.existencias : null;
    let origenExistencias = existencias === null ? null : 'archivo';
    if (existencias === null) {
      const delHistorial = contexto.historial.existenciasArchivo.get(u.clave);
      if (delHistorial) {
        existencias = delHistorial.valor;
        origenExistencias = 'historial';
      }
    }
    const enCamino = datos && Number.isFinite(datos.enCamino) ? datos.enCamino : 0;
    const decision = decidirPedido(r, existencias, enCamino, decimales);
    return Object.assign(r, {
      clave: u.clave,
      producto: u.codigo,
      nombre: u.nombre || (datos && datos.nombre) || '',
      indiceSerie: u.indice,
      existencias,
      origenExistencias,
      enCamino,
      estado: decision.estado,
      cuanto: decision.cuanto,
      posicion: decision.posicion,
      alcanzaDias: decision.posicion !== null && r.ventaDiaria > 0 ? decision.posicion / r.ventaDiaria : null,
      ultimaVenta: u.indice >= 0 ? s.ultimaVenta[u.indice] : null,
      origenPlazo: plazoArchivo ? 'archivo' : 'general',
      origenNivel: nivel.origen,
      decimales
    });
  }

  function resumir(resultados) {
    const r = {
      total: resultados.length, pedir: 0, bien: 0, sinVenta: 0, sinExistencias: 0,
      regulares: 0, esporadicos: 0, quietas: 0, conExistencias: 0
    };
    for (const x of resultados) {
      if (x.estado === 'pedir') r.pedir += 1;
      else if (x.estado === 'bien') r.bien += 1;
      else if (x.estado === 'sin_existencias') r.sinExistencias += 1;
      if (x.tipo === 'sin_venta') {
        r.sinVenta += 1;
        if (x.existencias > 0) r.quietas += x.existencias;
      } else if (x.tipo === 'regular') r.regulares += 1;
      else r.esporadicos += 1;
      if (x.existencias !== null) r.conExistencias += 1;
    }
    return r;
  }

  /** Todo de una vez (para pruebas y catálogos chicos). */
  function calcularTodo(entrada) {
    const contexto = prepararCalculo(entrada);
    const resultados = [];
    for (let i = 0; i < contexto.universo.length; i++) resultados.push(calcularIndice(contexto, i));
    return { contexto, resultados, resumen: resumir(resultados) };
  }

  /** Las esperas repetidas de un producto, para su gráfico: lo vendido en cada una, ordenado. */
  function esperasDe(contexto, resultado) {
    const serie = resultado.indiceSerie >= 0 ? contexto.series.series[resultado.indiceSerie] : contexto.vacia;
    const veces = contexto.parametros.veces || REMUESTRAS;
    return remuestrear(serie, resultado.plazoEfectivo, veces, generador((SEMILLA ^ semillaDe(resultado.clave)) >>> 0)).sort();
  }

  /** Cuántas de las esperas repetidas no pasan de `punto`. */
  function cobertura(sumasOrdenadas, punto) {
    let bajo = 0;
    let alto = sumasOrdenadas.length;
    while (bajo < alto) {
      const medio = (bajo + alto) >> 1;
      if (sumasOrdenadas[medio] <= punto + 1e-9) bajo = medio + 1;
      else alto = medio;
    }
    return sumasOrdenadas.length ? bajo / sumasOrdenadas.length : 0;
  }

  /** Agrupa las esperas en barras: una por valor si caben, si no, en tramos de igual ancho. */
  function histograma(sumasOrdenadas, maxBarras = 40) {
    const n = sumasOrdenadas.length;
    if (!n) return { ancho: 1, barras: [] };
    const minimo = sumasOrdenadas[0];
    const maximo = sumasOrdenadas[n - 1];
    const rango = maximo - minimo;
    const enteros = sumasOrdenadas.every((x) => Math.abs(x - Math.round(x)) < 1e-9);
    let ancho;
    let cantidad;
    if (enteros) {
      ancho = Math.max(1, Math.ceil((rango + 1) / maxBarras));
      cantidad = Math.ceil((rango + 1) / ancho);
    } else if (rango > 0) {
      ancho = rango / maxBarras;
      cantidad = maxBarras;
    } else {
      ancho = 1;
      cantidad = 1;
    }
    const barras = [];
    for (let i = 0; i < cantidad; i++) {
      const desde = minimo + i * ancho;
      barras.push({ desde, hasta: enteros ? desde + ancho - 1 : desde + ancho, cuenta: 0 });
    }
    for (let k = 0; k < n; k++) {
      let i = Math.floor((sumasOrdenadas[k] - minimo) / ancho + 1e-9);
      if (i >= cantidad) i = cantidad - 1;
      barras[i].cuenta += 1;
    }
    return { ancho, enteros, barras };
  }

  // ----------------------------------------------------------------- salida

  const TIPOS = { regular: 'Regular', esporadico: 'Esporádico', sin_venta: 'Sin venta' };
  const ESTADOS = { pedir: 'Pedir ahora', bien: 'Bien', no_se_pide: 'No se pide', sin_existencias: 'Faltan existencias' };

  function campoCSV(valor, separador) {
    let s = valor == null ? '' : String(valor);
    // Un texto que empieza con = + - @ se abre en Excel como fórmula: se le antepone un apóstrofo.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (s.includes(separador) || s.includes('"') || /[\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function numeroCSV(valor, decimales, decimal) {
    if (valor == null || !Number.isFinite(valor)) return '';
    const s = redondear(valor, decimales).toFixed(decimales);
    return decimal === ',' ? s.replace('.', ',') : s;
  }

  /**
   * Los resultados en CSV para Excel. Con `decimal` "," usa punto y coma como
   * separador (Excel en español); con "." usa coma.
   */
  function resultadosCSV(resultados, { decimal = ',' } = {}) {
    const separador = decimal === ',' ? ';' : ',';
    const titulos = ['Producto', 'Nombre', 'Tipo', 'Venta diaria', 'Colchón', 'Punto de pedido', 'Existencias',
      'En camino', 'Pedir ahora', 'Cuánto pedir', 'Lote', 'Plazo (días)', 'Nivel de servicio',
      'Sale cada (días)', 'Salen cuando sale', 'Última venta'];
    const lineas = [titulos.map((t) => campoCSV(t, separador)).join(separador)];
    for (const r of resultados) {
      const d = r.decimales || 0;
      const fila = [
        campoCSV(r.producto, separador),
        campoCSV(r.nombre, separador),
        TIPOS[r.tipo],
        numeroCSV(r.ventaDiaria, r.ventaDiaria > 0 && r.ventaDiaria < 0.1 ? 3 : 2, decimal),
        numeroCSV(r.colchon, d, decimal),
        numeroCSV(r.punto, d, decimal),
        numeroCSV(r.existencias, d, decimal),
        r.existencias === null ? '' : numeroCSV(r.enCamino, d, decimal),
        r.estado === 'pedir' ? 'Sí' : r.estado === 'bien' || r.estado === 'no_se_pide' ? 'No' : '',
        r.estado === 'pedir' ? numeroCSV(r.cuanto, d, decimal) : '',
        r.tipo === 'sin_venta' ? '' : numeroCSV(r.lote, d, decimal),
        numeroCSV(r.plazo, 1, decimal).replace(/[.,]0$/, ''),
        numeroCSV(r.nivel * 100, 1, decimal).replace(/[.,]0$/, '') + ' %',
        numeroCSV(r.cadaCuantosDias, 1, decimal),
        numeroCSV(r.cuantasCuandoSale, 1, decimal),
        r.ultimaVenta === null ? '' : fechaISO(r.ultimaVenta)
      ];
      lineas.push(fila.join(separador));
    }
    return '﻿' + lineas.join('\r\n') + '\r\n';
  }

  return {
    CORTE_ESPORADICO, REMUESTRAS, SEMILLA, NIVEL_MINIMO, NIVEL_MAXIMO, CAMPOS, REQUERIDOS, TIPOS, ESTADOS,
    normalizar, separarCodigo, claveProducto,
    leerNumero, detectarDecimal, contarDecimales, redondear, redondearArriba,
    formatear, formatearNivel, decimalesVenta,
    diaDeFecha, fechaDeDia, diaSemana, fechaISO, fechaCorta, fechaSinAnio, nombreDia, leerFecha, detectarOrdenFecha,
    detectarDelimitador, leerCSV,
    detectarColumnas, encontrarEncabezado, completarPorContenido, leerEstructura,
    prepararHistorial, leerPorProducto, construirSeries,
    media, desviacion, inversaNormal, generador, semillaDe, remuestrear, percentilAlto, clasificar,
    cuentaRegular, cuentaEsporadica, guardarDuranteUnLote, nivelPorCostos, acotarNivel,
    calcularProducto, decidirPedido, prepararCalculo, calcularIndice, resumir, calcularTodo,
    esperasDe, cobertura, histograma, resultadosCSV
  };
});
