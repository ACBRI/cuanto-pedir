'use strict';
// Pruebas de la cuenta y de la lectura de archivos. Se corren con `node --test`.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculo.js');

const cerca = (real, esperado, tolerancia = 1e-9) =>
  assert.ok(Math.abs(real - esperado) <= tolerancia, `${real} no está cerca de ${esperado}`);

/** Un historial de una línea por día, todos los días, para un solo producto. */
function historialDiario(producto, valores, inicio = '2026-04-01') {
  const lineas = ['fecha;producto;cantidad'];
  const primerDia = C.leerFecha(inicio);
  valores.forEach((v, k) => {
    if (v > 0) lineas.push(`${C.fechaISO(primerDia + k)};${producto};${v}`);
  });
  return lineas.join('\n');
}

function calcularDesdeTexto(texto, parametros = {}) {
  const { filas, delimitador } = C.leerCSV(texto);
  const e = C.leerEstructura(filas, 'historial');
  const historial = C.prepararHistorial(filas, e.desde, e.columnas, { delimitador });
  return C.calcularTodo({
    historial,
    info: new Map(),
    parametros: Object.assign({ plazo: 10, modoNivel: 'fijo', nivel: 0.95, diasLote: 30 }, parametros)
  });
}

describe('inversa de la normal', () => {
  test('valores conocidos', () => {
    assert.equal(C.inversaNormal(0.95).toFixed(4), '1.6449');
    assert.equal(C.inversaNormal(0.975).toFixed(4), '1.9600');
    assert.equal(C.inversaNormal(0.5), 0);
    assert.equal(C.inversaNormal(0.99).toFixed(4), '2.3263');
    assert.equal(C.inversaNormal(0.01).toFixed(4), '-2.3263');
    assert.equal(C.inversaNormal(0.999).toFixed(4), '3.0902');
    assert.equal(C.inversaNormal(0.84134474606854).toFixed(4), '1.0000');
  });

  test('es simétrica y precisa en las colas', () => {
    for (const p of [0.001, 0.02, 0.0243, 0.1, 0.3, 0.49]) cerca(C.inversaNormal(p), -C.inversaNormal(1 - p), 1e-8);
    cerca(C.inversaNormal(0.95), 1.6448536269514722, 1e-8);
    cerca(C.inversaNormal(0.975), 1.959963984540054, 1e-8);
  });

  test('fuera de rango', () => {
    assert.equal(C.inversaNormal(0), -Infinity);
    assert.equal(C.inversaNormal(1), Infinity);
    assert.ok(Number.isNaN(C.inversaNormal(1.5)));
  });
});

describe('producto regular', () => {
  test('media 4, desviación 2, plazo 10, 95 %: colchón 11 y punto 51', () => {
    const c = C.cuentaRegular({ ventaDiaria: 4, desviacion: 2, plazo: 10, nivel: 0.95 });
    assert.equal(c.ventaEspera, 40);
    assert.equal(c.colchon, 11);
    assert.equal(c.punto, 51);
  });

  test('la misma cifra sale de un historial de 180 días con esa media y esa desviación', () => {
    const valores = Array.from({ length: 180 }, (_, k) => (k % 2 ? 6 : 2));
    const { resultados } = calcularDesdeTexto(historialDiario('BISAGRA', valores));
    const r = resultados[0];
    assert.equal(r.tipo, 'regular');
    cerca(r.ventaDiaria, 4);
    cerca(r.desviacion, 2, 0.01);
    assert.equal(r.colchon, 11);
    assert.equal(r.punto, 51);
    assert.equal(r.lote, 120);
  });

  test('el colchón crece con lo irregular de la venta y con el plazo', () => {
    const base = C.cuentaRegular({ ventaDiaria: 4, desviacion: 2, plazo: 10, nivel: 0.95 });
    const masIrregular = C.cuentaRegular({ ventaDiaria: 4, desviacion: 4, plazo: 10, nivel: 0.95 });
    const masPlazo = C.cuentaRegular({ ventaDiaria: 4, desviacion: 2, plazo: 40, nivel: 0.95 });
    assert.ok(masIrregular.colchon > base.colchon);
    assert.ok(masPlazo.colchon > base.colchon);
  });

  test('redondeo hacia arriba sin el ruido de la coma flotante', () => {
    assert.equal(C.redondearArriba(10.403), 11);
    assert.equal(C.redondearArriba(11.0000000001), 11);
    assert.equal(C.redondearArriba(0.30000000000000004, 1), 0.3);
    assert.equal(C.redondearArriba(1.21, 1), 1.3);
  });
});

describe('producto esporádico', () => {
  // Sale 2 unidades cada 8 días: 23 días con venta en 180.
  const serie = Float64Array.from({ length: 180 }, (_, k) => (k % 8 === 0 ? 2 : 0));

  test('se clasifica como esporádico, con cada cuánto sale y cuántas salen', () => {
    const r = C.calcularProducto(serie, { plazo: 10, nivel: 0.95, diasLote: 30 });
    assert.equal(r.tipo, 'esporadico');
    assert.equal(r.diasConVenta, 23);
    cerca(r.cadaCuantosDias, 180 / 23);
    assert.equal(r.cuantasCuandoSale, 2);
  });

  test('el punto es la cifra que cubre el 95 % de las esperas repetidas', () => {
    const r = C.calcularProducto(serie, { plazo: 10, nivel: 0.95, diasLote: 30 });
    // Con 10 días tomados al azar, salir 3 veces o menos pasa en el 97 % de las esperas; 2 o menos, en el 87 %.
    assert.equal(r.punto, 6);
    assert.equal(r.ventaEspera, 3);
    assert.equal(r.colchon, 3);
    const lo = C.calcularProducto(serie, { plazo: 10, nivel: 0.95, diasLote: 30 });
    assert.equal(lo.punto, r.punto, 'con semilla fija, el resultado se repite');
  });

  test('el promedio se queda corto', () => {
    const sumas = C.remuestrear(serie, 10, C.REMUESTRAS, C.generador(C.SEMILLA)).sort();
    const ingenuo = Math.ceil(C.media(serie) * 10);
    assert.ok(C.cobertura(sumas, ingenuo) < 0.9);
    assert.ok(C.cobertura(sumas, 6) >= 0.95);
  });

  test('percentil tomando el valor de arriba', () => {
    const lista = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(C.percentilAlto(lista, 0.95), 10);
    assert.equal(C.percentilAlto(lista, 0.5), 6);
    assert.equal(C.percentilAlto(lista, 0), 1);
    assert.equal(C.percentilAlto(Float64Array.from([0, 0, 0, 1]), 0.5), 0);
  });

  test('el remuestreo admite plazos con fracción', () => {
    const unos = new Float64Array(100).fill(1);
    const sumas = C.remuestrear(unos, 7.5, 4000, C.generador(3));
    const promedio = C.media(sumas);
    assert.ok(promedio > 7.4 && promedio < 7.6, `promedio ${promedio}`);
  });
});

describe('producto sin venta', () => {
  test('no se pide', () => {
    const r = C.calcularProducto(new Float64Array(180), { plazo: 10, nivel: 0.95, diasLote: 30 });
    assert.equal(r.tipo, 'sin_venta');
    assert.equal(r.punto, 0);
    assert.equal(r.lote, 0);
    const d = C.decidirPedido(r, 40, 0);
    assert.equal(d.estado, 'no_se_pide');
    assert.equal(d.cuanto, 0);
  });
});

describe('nivel de servicio por costos', () => {
  test('margen 1,00 y guardar un mes 0,05 dan 0,95', () => {
    cerca(C.nivelPorCostos(1.0, 0.05), 0.95);
  });

  test('guardar una unidad de 2,40 un mes al 25 % anual cuesta 0,05', () => {
    const guardar = C.guardarDuranteUnLote(2.4, 0.25, 30);
    cerca(guardar, 0.0493, 1e-4);
    cerca(C.nivelPorCostos(1.0, guardar), 0.9507, 1e-4);
  });

  test('se acota entre 50 % y 99,9 %', () => {
    assert.equal(C.acotarNivel(0.2), 0.5);
    assert.equal(C.acotarNivel(0.99999), 0.999);
    assert.equal(C.acotarNivel(NaN), 0.5);
    assert.ok(Number.isNaN(C.nivelPorCostos(0, 0.05)));
  });

  test('con costo y precio por producto, cada uno tiene su nivel', () => {
    const valores = Array.from({ length: 120 }, (_, k) => (k % 2 ? 6 : 2));
    const { filas } = C.leerCSV(historialDiario('A', valores) + '\n' +
      historialDiario('B', valores).split('\n').slice(1).join('\n'));
    const e = C.leerEstructura(filas, 'historial');
    const historial = C.prepararHistorial(filas, e.desde, e.columnas);
    const info = new Map([['A', { codigo: 'A', costo: 10, precio: 11 }]]);
    const { resultados } = C.calcularTodo({
      historial, info,
      parametros: { plazo: 10, modoNivel: 'costos', margen: 1, costo: 2.4, tasaGuardar: 0.25, diasLote: 30 }
    });
    const a = resultados.find((r) => r.clave === 'A');
    const b = resultados.find((r) => r.clave === 'B');
    assert.equal(a.origenNivel, 'archivo');
    cerca(a.nivel, 1 - C.guardarDuranteUnLote(10, 0.25, 30) / 1, 1e-9);
    assert.equal(b.origenNivel, 'general');
    cerca(b.nivel, 1 - C.guardarDuranteUnLote(2.4, 0.25, 30) / 1, 1e-9);
  });
});

describe('cuándo y cuánto pedir', () => {
  const r = { tipo: 'regular', punto: 51, lote: 120 };

  test('pedir si existencias más lo que viene en camino no pasa del punto', () => {
    assert.deepEqual(C.decidirPedido(r, 30, 0), { estado: 'pedir', cuanto: 141, posicion: 30 });
    assert.deepEqual(C.decidirPedido(r, 51, 0), { estado: 'pedir', cuanto: 120, posicion: 51 });
    assert.deepEqual(C.decidirPedido(r, 30, 25), { estado: 'bien', cuanto: 0, posicion: 55 });
  });

  test('sin existencias no se decide', () => {
    assert.equal(C.decidirPedido(r, null, 0).estado, 'sin_existencias');
  });
});

describe('detección de columnas', () => {
  const casos = [
    [['fecha', 'documento', 'codigo', 'producto', 'cantidad'], { fecha: 0, producto: 2, nombre: 3, cantidad: 4 }],
    [['Fecha', 'Código', 'Descripción', 'Cantidad'], { fecha: 0, producto: 1, nombre: 2, cantidad: 3 }],
    [['FECHA DE VENTA', 'Artículo', 'Unidades'], { fecha: 0, producto: 1, cantidad: 2 }],
    [['Date', 'SKU', 'Qty'], { fecha: 0, producto: 1, cantidad: 2 }],
    [['DocDate', 'ItemCode', 'Dscription', 'Quantity'], { fecha: 0, producto: 1, nombre: 2, cantidad: 3 }],
    [['Fecha', 'Referencia', 'Producto', 'Cantidad'], { fecha: 0, producto: 2, cantidad: 3 }],
    [['Producto/Referencia interna', 'Producto', 'Fecha', 'Cantidad'], { fecha: 2, producto: 0, nombre: 1, cantidad: 3 }],
    [['Fecha de vencimiento', 'Fecha', 'Cliente', 'Producto', 'Cantidad', 'Precio unitario', 'Total'],
      { fecha: 1, producto: 3, cantidad: 4 }],
    [['fecha', 'producto', 'cantidad', 'existencias'], { fecha: 0, producto: 1, cantidad: 2, existencias: 3 }]
  ];
  for (const [titulos, esperado] of casos) {
    test(titulos.join(' | '), () => {
      const c = C.detectarColumnas(titulos, 'historial');
      for (const [campo, i] of Object.entries(esperado)) assert.equal(c[campo], i, `${campo} en ${titulos.join(', ')}`);
    });
  }

  test('existencias de Odoo y de SAP Business One', () => {
    const odoo = C.detectarColumnas(['Referencia interna', 'Nombre', 'Cantidad a mano', 'Cantidad pronosticada',
      'Costo', 'Precio de venta'], 'existencias');
    assert.deepEqual([odoo.producto, odoo.nombre, odoo.existencias, odoo.costo, odoo.precio], [0, 1, 2, 4, 5]);
    assert.equal(odoo.enCamino, -1);
    const sap = C.detectarColumnas(['ItemCode', 'ItemName', 'OnHand', 'IsCommited', 'OnOrder', 'LeadTime'], 'existencias');
    assert.deepEqual([sap.producto, sap.nombre, sap.existencias, sap.enCamino, sap.plazo], [0, 1, 2, 4, 5]);
  });

  test('plazos', () => {
    const c = C.detectarColumnas(['codigo', 'proveedor', 'plazo_dias'], 'plazos');
    assert.equal(c.producto, 0);
    assert.equal(c.plazo, 2);
  });

  test('salta las filas de título de un informe', () => {
    const filas = [['Informe de ventas'], ['Del 1 al 30 de abril'], ['Fecha', 'Producto', 'Cantidad'], ['01/04/2026', 'A', '3']];
    assert.equal(C.encontrarEncabezado(filas, 'historial'), 2);
  });

  test('sin títulos, encuentra las columnas por lo que contienen', () => {
    const filas = [['01/04/2026', 'A', '3'], ['02/04/2026', 'B', '5'], ['03/04/2026', 'A', '1']];
    const e = C.leerEstructura(filas, 'historial');
    assert.equal(e.encabezado, -1);
    assert.equal(e.desde, 0);
    assert.deepEqual([e.columnas.fecha, e.columnas.producto, e.columnas.cantidad], [0, 1, 2]);
  });

  test('con títulos desconocidos, también por contenido', () => {
    const filas = [['Día de la operación', 'Item', 'Total unidades'], ['2026-04-01', 'A', '3'], ['2026-04-02', 'B', '4'], ['2026-04-03', 'C', '1']];
    const e = C.leerEstructura(filas, 'historial');
    assert.equal(e.columnas.fecha, 0);
    assert.equal(e.columnas.producto, 1);
    assert.equal(e.columnas.cantidad, 2);
  });
});

describe('lectura de CSV', () => {
  test('con coma', () => {
    const { filas, delimitador } = C.leerCSV('fecha,producto,cantidad\r\n2026-04-01,"Jarabe, 120 ml",3\r\n2026-04-02,"Dice ""hola""",4\r\n');
    assert.equal(delimitador, ',');
    assert.deepEqual(filas, [['fecha', 'producto', 'cantidad'], ['2026-04-01', 'Jarabe, 120 ml', '3'], ['2026-04-02', 'Dice "hola"', '4']]);
  });

  test('con punto y coma, BOM y comas decimales', () => {
    const { filas, delimitador } = C.leerCSV('﻿fecha;producto;cantidad\n01/04/2026;Paracetamol 500 mg, caja x 100;2,5\n02/04/2026;Ibuprofeno;1,25\n');
    assert.equal(delimitador, ';');
    assert.equal(filas[1][1], 'Paracetamol 500 mg, caja x 100');
    assert.equal(filas[2][2], '1,25');
  });

  test('con tabuladores y con la línea sep= de Excel', () => {
    assert.equal(C.leerCSV('a\tb\tc\n1\t2\t3').delimitador, '\t');
    const r = C.leerCSV('sep=;\na;b\n1;2\n');
    assert.equal(r.delimitador, ';');
    assert.deepEqual(r.filas, [['a', 'b'], ['1', '2']]);
  });

  test('salto de línea dentro de un campo y filas vacías', () => {
    const { filas } = C.leerCSV('a,b\n"uno\ndos",2\n\n,\n3,4');
    assert.deepEqual(filas, [['a', 'b'], ['uno\ndos', '2'], ['3', '4']]);
  });
});

describe('fechas', () => {
  const abril1 = C.diaDeFecha(2026, 4, 1);
  const formatos = [
    '2026-04-01', '2026-04-01 10:23:00', '2026-04-01T10:23:00Z', '2026/04/01', '01/04/2026', '1/4/2026',
    '01-04-2026', '01.04.2026', '1/4/26', '1 abr 2026', '01-abr-2026', '1 de abril de 2026', '1 Abr. 2026',
    'miércoles, 1 de abril de 2026', 'Apr 1, 2026', 'April 1 2026', '20260401', '46113'
  ];
  for (const f of formatos) {
    test(f, () => assert.equal(C.leerFecha(f, 'dma'), abril1));
  }

  test('números de Excel y objetos Date', () => {
    assert.equal(C.leerFecha(46113), abril1);
    assert.equal(C.leerFecha(46113.75), abril1);
    assert.equal(C.leerFecha(20260401), abril1);
    assert.equal(C.leerFecha(new Date(2026, 3, 1, 15, 30)), abril1);
    assert.equal(C.leerFecha(44651, 'dma', { fecha1904: true }), C.leerFecha(44651 + 1462));
  });

  test('mes y día en orden de Estados Unidos', () => {
    assert.equal(C.detectarOrdenFecha(['04/13/2026', '04/01/2026']), 'mda');
    assert.equal(C.detectarOrdenFecha(['13/04/2026', '01/04/2026']), 'dma');
    assert.equal(C.detectarOrdenFecha(['01/04/2026']), 'dma');
    assert.equal(C.leerFecha('4/1/2026', 'mda'), abril1);
    assert.equal(C.leerFecha('Mar 15, 2026'), C.diaDeFecha(2026, 3, 15));
  });

  test('fechas que no existen', () => {
    for (const f of ['31/02/2026', '2026-13-01', 'mañana', '', '12345', '1 foo 2026']) {
      assert.ok(Number.isNaN(C.leerFecha(f, 'dma')), f);
    }
    assert.ok(Number.isNaN(C.leerFecha(15)), 'una cantidad no es una fecha');
  });

  test('día de la semana y textos', () => {
    assert.equal(C.diaSemana(abril1), 3);
    assert.equal(C.nombreDia(C.diaDeFecha(2026, 4, 6)), 'lunes');
    assert.equal(C.fechaCorta(abril1), '1 abr 2026');
    assert.equal(C.fechaISO(abril1), '2026-04-01');
  });
});

describe('números y decimales con coma', () => {
  test('leer números', () => {
    assert.equal(C.leerNumero('2,5', ','), 2.5);
    assert.equal(C.leerNumero('1.234,5', ','), 1234.5);
    assert.equal(C.leerNumero('1,234.5', '.'), 1234.5);
    assert.equal(C.leerNumero('1.234', ','), 1234);
    assert.equal(C.leerNumero('2,40'), 2.4);
    assert.equal(C.leerNumero(' 12 '), 12);
    assert.equal(C.leerNumero('(5)'), -5);
    assert.equal(C.leerNumero('5-'), -5);
    assert.equal(C.leerNumero('USD 3,50'), 3.5);
    assert.equal(C.leerNumero('25 %'), 25);
    assert.equal(C.leerNumero(7), 7);
    assert.ok(Number.isNaN(C.leerNumero('abc')));
    assert.ok(Number.isNaN(C.leerNumero('')));
  });

  test('detectar el separador decimal de una columna', () => {
    assert.equal(C.detectarDecimal(['2,5', '3', '1,25'], ';'), ',');
    assert.equal(C.detectarDecimal(['2.5', '3', '1.25'], ','), '.');
    assert.equal(C.detectarDecimal(['1.234,5'], ','), ',');
    assert.equal(C.detectarDecimal(['1,234.5'], ';'), '.');
    assert.equal(C.detectarDecimal(['1.234', '5'], ';'), ',');
    assert.equal(C.detectarDecimal(['1.234', '5'], ','), '.');
  });

  test('un historial en kilos con coma decimal', () => {
    const texto = 'Fecha;Artículo;Cantidad\n01/04/2026;Lactosa;2,5\n01/04/2026;Lactosa;1,25\n02/04/2026;Lactosa;1.000,5\n';
    const { filas, delimitador } = C.leerCSV(texto);
    const e = C.leerEstructura(filas, 'historial');
    const h = C.prepararHistorial(filas, e.desde, e.columnas, { delimitador });
    assert.equal(h.decimal, ',');
    assert.equal(h.decimales, 2);
    const s = C.construirSeries(h);
    assert.deepEqual(Array.from(s.series[0]), [3.75, 1000.5]);
  });

  test('contar decimales', () => {
    assert.equal(C.contarDecimales([1, 2, 3]), 0);
    assert.equal(C.contarDecimales([1.5, 2]), 1);
    assert.equal(C.contarDecimales([0.125, 2]), 3);
    assert.equal(C.contarDecimales([1 / 3]), 3);
  });

  test('formatear para la pantalla', () => {
    assert.equal(C.formatear(1234.5, 1), '1.234,5');
    assert.equal(C.formatear(51), '51');
    assert.equal(C.formatear(5000), '5.000');
    assert.equal(C.formatear(-3.2, 1), '−3,2');
    assert.equal(C.formatear(NaN), '—');
    assert.equal(C.formatearNivel(0.95), '95 %');
    assert.equal(C.formatearNivel(0.9507), '95,1 %');
  });
});

describe('historial', () => {
  test('suma varias filas del mismo día y cruza códigos con corchetes', () => {
    const texto = 'Fecha,Producto,Cantidad\n2026-04-01,[PT-001] Paracetamol,3\n2026-04-01,[PT-001] Paracetamol,2\n2026-04-02,PT-001,4\n';
    const { filas } = C.leerCSV(texto);
    const e = C.leerEstructura(filas, 'historial');
    const h = C.prepararHistorial(filas, e.desde, e.columnas);
    assert.equal(h.productos.length, 1);
    assert.equal(h.productos[0].codigo, 'PT-001');
    assert.equal(h.productos[0].nombre, 'Paracetamol');
    assert.deepEqual(Array.from(C.construirSeries(h).series[0]), [5, 4]);
  });

  test('ignora devoluciones y cuenta lo que no se pudo leer', () => {
    const texto = 'fecha;producto;cantidad\n01/04/2026;A;5\n02/04/2026;A;-2\nayer;A;3\n03/04/2026;;3\n04/04/2026;A;tres\n';
    const { filas, delimitador } = C.leerCSV(texto);
    const e = C.leerEstructura(filas, 'historial');
    const h = C.prepararHistorial(filas, e.desde, e.columnas, { delimitador });
    assert.equal(h.cuenta.devoluciones, 1);
    assert.equal(h.cuenta.sinFecha, 1);
    assert.equal(h.cuenta.sinProducto, 1);
    assert.equal(h.cuenta.sinCantidad, 1);
    assert.equal(h.cuenta.usadas, 1);
  });

  test('si todas las cantidades son negativas, son salidas', () => {
    const texto = 'fecha;producto;cantidad\n01/04/2026;A;-5\n02/04/2026;A;-2\n';
    const { filas, delimitador } = C.leerCSV(texto);
    const e = C.leerEstructura(filas, 'historial');
    const h = C.prepararHistorial(filas, e.desde, e.columnas, { delimitador });
    assert.equal(h.cuenta.invertidas, true);
    assert.deepEqual(Array.from(C.construirSeries(h).series[0]), [5, 2]);
  });

  test('una empresa que no vende sábados ni domingos trabaja en días de trabajo', () => {
    // 12 semanas desde el lunes 6 de abril de 2026, venta todos los días hábiles.
    const lunes = C.diaDeFecha(2026, 4, 6);
    const lineas = ['fecha;producto;cantidad'];
    for (let k = 0; k < 84; k++) {
      const dia = lunes + k;
      const s = C.diaSemana(dia);
      if (s === 0 || s === 6) continue;
      lineas.push(`${C.fechaISO(dia)};DIARIO;${3 + (k % 3)}`);
      if (k % 9 === 0) lineas.push(`${C.fechaISO(dia)};RARO;2`);
    }
    const { resultados, contexto } = calcularDesdeTexto(lineas.join('\n'));
    assert.deepEqual(contexto.series.cerrados, [0, 6]);
    cerca(contexto.series.factor, 60 / 82, 1e-9);
    const diario = resultados.find((r) => r.clave === 'DIARIO');
    assert.equal(diario.tipo, 'regular');
    cerca(diario.plazoEfectivo, 10 * 60 / 82, 1e-9);
    assert.equal(resultados.find((r) => r.clave === 'RARO').tipo, 'esporadico');
  });

  test('los últimos días: el periodo empieza en el corte y lo vendido antes no cuenta', () => {
    const texto = 'fecha;producto;cantidad\n01/01/2026;VIEJO;5\n01/04/2026;NUEVO;5\n30/06/2026;NUEVO;4\n';
    const { resultados, contexto } = calcularDesdeTexto(texto, { ultimosDias: 120 });
    assert.equal(contexto.series.diasCalendario, 120);
    assert.equal(contexto.series.fin, C.diaDeFecha(2026, 6, 30));
    assert.equal(resultados.find((r) => r.clave === 'VIEJO').tipo, 'sin_venta');
    const todo = calcularDesdeTexto(texto, { ultimosDias: 0 });
    assert.equal(todo.contexto.series.diasCalendario, 181);
    const corto = calcularDesdeTexto(texto, { ultimosDias: 400 });
    assert.equal(corto.contexto.series.diasCalendario, 181, 'un corte más largo que el archivo usa todo el archivo');
  });

  test('existencias y plazos por producto', () => {
    const valores = Array.from({ length: 180 }, (_, k) => (k % 2 ? 6 : 2));
    const { filas } = C.leerCSV(historialDiario('PT-001', valores));
    const e = C.leerEstructura(filas, 'historial');
    const historial = C.prepararHistorial(filas, e.desde, e.columnas);
    const ex = C.leerCSV('Código;Existencias;En camino\nPT-001;30;0\n0099;12;0\n');
    const ee = C.leerEstructura(ex.filas, 'existencias');
    const info = C.leerPorProducto(ex.filas, ee.desde, ee.columnas, { delimitador: ';' }).porClave;
    const { resultados, resumen } = C.calcularTodo({
      historial, info, parametros: { plazo: 10, modoNivel: 'fijo', nivel: 0.95, diasLote: 30 }
    });
    const pt = resultados.find((r) => r.clave === 'PT-001');
    assert.equal(pt.estado, 'pedir');
    assert.equal(pt.cuanto, 51 + 120 - 30);
    const quieto = resultados.find((r) => r.clave === '99');
    assert.equal(quieto.tipo, 'sin_venta');
    assert.equal(quieto.estado, 'no_se_pide');
    assert.equal(resumen.pedir, 1);
    assert.equal(resumen.sinVenta, 1);
    assert.equal(resumen.quietas, 12);

    const pl = C.leerCSV('codigo,plazo\nPT-001,40\n');
    const pe = C.leerEstructura(pl.filas, 'plazos');
    const plazos = C.leerPorProducto(pl.filas, pe.desde, pe.columnas).porClave;
    const conPlazo = C.calcularTodo({
      historial, info: plazos, parametros: { plazo: 10, modoNivel: 'fijo', nivel: 0.95, diasLote: 30 }
    }).resultados[0];
    assert.equal(conPlazo.plazo, 40);
    assert.equal(conPlazo.origenPlazo, 'archivo');
    assert.equal(conPlazo.punto, 160 + Math.ceil(C.inversaNormal(0.95) * conPlazo.desviacion * Math.sqrt(40)));
  });
});

describe('existencias y plazos juntos', () => {
  test('el plazo manda desde su archivo; lo que solo está en plazos no entra al catálogo', () => {
    const existencias = new Map([['A', { codigo: 'A', existencias: 10, plazo: 5 }], ['B', { codigo: 'B', existencias: 3 }]]);
    const plazos = new Map([['A', { codigo: 'A', plazo: 20 }], ['Z', { codigo: 'Z', nombre: 'Solo en plazos', plazo: 9 }]]);
    const info = C.unirPorProducto(existencias, plazos);
    assert.equal(info.get('A').plazo, 20);
    assert.equal(info.get('A').existencias, 10);
    assert.equal(info.get('B').plazo, undefined);
    assert.equal(info.get('Z').soloPlazo, true);

    const { filas } = C.leerCSV('fecha,producto,cantidad\n2026-04-01,A,3\n2026-04-02,A,4\n');
    const e = C.leerEstructura(filas, 'historial');
    const historial = C.prepararHistorial(filas, e.desde, e.columnas);
    const { resultados } = C.calcularTodo({ historial, info, parametros: { plazo: 10, modoNivel: 'fijo', nivel: 0.95, diasLote: 30 } });
    assert.deepEqual(resultados.map((r) => r.clave).sort(), ['A', 'B']);
  });

  test('varias filas del mismo producto en existencias se suman', () => {
    const { filas } = C.leerCSV('producto;bodega;existencias\nA;Quito;10\nA;Guayaquil;5,5\n');
    const e = C.leerEstructura(filas, 'existencias');
    const r = C.leerPorProducto(filas, e.desde, e.columnas, { delimitador: ';' });
    assert.equal(r.porClave.get('A').existencias, 15.5);
  });
});

describe('claves de producto', () => {
  test('cruza códigos escritos distinto', () => {
    assert.equal(C.claveProducto('[PT-001] Paracetamol'), 'PT-001');
    assert.equal(C.claveProducto(' pt-001 '), 'PT-001');
    assert.equal(C.claveProducto('00123'), '123');
    assert.equal(C.claveProducto(123), '123');
    assert.equal(C.claveProducto('123.0'), '123');
    assert.equal(C.claveProducto('78612345678901234567'), '78612345678901234567');
  });
});

describe('salida', () => {
  test('CSV para Excel en español y en inglés', () => {
    const valores = Array.from({ length: 180 }, (_, k) => (k % 2 ? 6 : 2));
    const { resultados } = calcularDesdeTexto(historialDiario('=MAL', valores));
    const es = C.resultadosCSV(resultados, { decimal: ',' });
    assert.ok(es.startsWith('﻿Producto;Nombre;Tipo;Venta diaria;Colchón;Punto de pedido'));
    const fila = es.split('\r\n')[1].split(';');
    assert.equal(fila[0], "'=MAL");
    assert.equal(fila[3], '4,00');
    assert.equal(fila[5], '51');
    assert.equal(fila[12], '95 %');
    const en = C.resultadosCSV(resultados, { decimal: '.' });
    assert.ok(en.split('\r\n')[1].includes(',4.00,'));
  });

  test('histograma de las esperas', () => {
    const h = C.histograma(Float64Array.from([3, 3, 4, 7]));
    assert.equal(h.barras.length, 5);
    assert.deepEqual(h.barras.map((b) => b.cuenta), [2, 1, 0, 0, 1]);
    const ancho = C.histograma(Float64Array.from({ length: 100 }, (_, i) => i), 40);
    assert.ok(ancho.barras.length <= 40);
    assert.equal(ancho.barras.reduce((s, b) => s + b.cuenta, 0), 100);
    assert.equal(C.histograma(Float64Array.from([2.5, 2.5])).barras.length, 1);
  });
});
