'use strict';
// Los datos de ejemplo: los archivos de ejemplo/ son los que genera la página,
// y la empresa ficticia da siempre el mismo resultado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../calculo.js');
const Ejemplo = require('../ejemplo.js');

const datos = Ejemplo.generar();

function leer(texto, tipo) {
  const { filas, delimitador } = C.leerCSV(texto);
  const e = C.leerEstructura(filas, tipo);
  return { filas, e, delimitador };
}

test('los archivos de ejemplo/ son los que genera ejemplo.js', () => {
  for (const [tipo, nombre] of Object.entries(Ejemplo.NOMBRES)) {
    const enDisco = fs.readFileSync(path.join(__dirname, '..', 'ejemplo', nombre), 'utf8');
    assert.equal(enDisco, datos[tipo], `${nombre} no coincide: corra node herramientas/escribir-ejemplo.js`);
  }
});

test('la generación se repite igual', () => {
  assert.deepEqual(Ejemplo.generar(), datos);
});

test('la empresa ficticia: 33 productos, 180 días, sin venta los fines de semana', () => {
  const h = leer(datos.historial, 'historial');
  assert.deepEqual([h.e.columnas.fecha, h.e.columnas.producto, h.e.columnas.nombre, h.e.columnas.cantidad], [0, 2, 3, 4]);
  const historial = C.prepararHistorial(h.filas, h.e.desde, h.e.columnas, { delimitador: h.delimitador });
  assert.equal(historial.cuenta.sinFecha + historial.cuenta.sinCantidad + historial.cuenta.sinProducto, 0);

  const info = new Map();
  for (const tipo of ['existencias', 'plazos']) {
    const x = leer(datos[tipo], tipo);
    const r = C.leerPorProducto(x.filas, x.e.desde, x.e.columnas, { delimitador: x.delimitador });
    for (const [clave, valor] of r.porClave) info.set(clave, Object.assign(info.get(clave) || {}, valor));
  }

  const { resultados, resumen, contexto } = C.calcularTodo({
    historial, info, parametros: { plazo: 10, modoNivel: 'fijo', nivel: 0.95, diasLote: 30 }
  });
  assert.equal(contexto.series.diasCalendario, Ejemplo.DIAS);
  assert.deepEqual(contexto.series.cerrados, [0, 6]);
  assert.equal(resumen.total, Ejemplo.PRODUCTOS);
  assert.deepEqual(
    [resumen.regulares, resumen.esporadicos, resumen.sinVenta, resumen.pedir, resumen.bien, resumen.quietas],
    [16, 13, 4, 10, 19, 235]
  );
  const jarabe = resultados.find((r) => r.clave === 'PT-008');
  assert.equal(jarabe.estado, 'bien', 'lo que viene en camino cuenta');
  assert.ok(jarabe.existencias <= jarabe.punto);
  const importado = resultados.find((r) => r.clave === 'PT-003');
  assert.equal(importado.plazo, 35);
  assert.equal(importado.origenPlazo, 'archivo');
});
