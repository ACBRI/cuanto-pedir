#!/usr/bin/env node
'use strict';
// Escribe en ejemplo/ los tres archivos de ejemplo que genera ejemplo.js, los
// mismos que carga el botón «Usar datos de ejemplo» de la página.
//
//   node herramientas/escribir-ejemplo.js

const fs = require('node:fs');
const path = require('node:path');
const Ejemplo = require('../ejemplo.js');

const carpeta = path.join(__dirname, '..', 'ejemplo');
fs.mkdirSync(carpeta, { recursive: true });
const datos = Ejemplo.generar();
for (const [tipo, nombre] of Object.entries(Ejemplo.NOMBRES)) {
  const destino = path.join(carpeta, nombre);
  fs.writeFileSync(destino, datos[tipo], 'utf8');
  console.log(`${path.relative(process.cwd(), destino)}: ${datos[tipo].trim().split('\n').length - 1} filas`);
}
