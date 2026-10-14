#!/usr/bin/env node
// Prueba de punta a punta: abre la página en un Chromium sin cabeza, como la
// abriría una persona, y la usa: con doble clic (file://) y servida por HTTP
// (como en GitHub Pages), en escritorio, en teléfono y en modo oscuro. Deja
// las capturas en docs/capturas/.
//
//   npm install            (una vez: instala playwright-core, sin navegadores)
//   npm run punta
//
// Usa el Chromium que ya tenga Playwright en ~/.cache/ms-playwright; otro se
// indica con NAVEGADOR=/ruta/al/chrome. Leer Excel necesita internet (el lector
// se descarga de cdnjs); sin conexión, esa parte se informa como omitida.

import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capturas = path.join(raiz, 'docs', 'capturas');
const datos = path.join(raiz, 'pruebas', 'datos');
const salida = path.join(raiz, 'pruebas', 'salida');
const PERMITIDOS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']);

function buscarNavegador() {
  if (process.env.NAVEGADOR) return process.env.NAVEGADOR;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const carpetas = fs.readdirSync(base).sort().reverse();
  for (const c of carpetas.filter((x) => x.startsWith('chromium_headless_shell-'))) {
    const ruta = path.join(base, c, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(ruta)) return ruta;
  }
  for (const c of carpetas.filter((x) => x.startsWith('chromium-'))) {
    const ruta = path.join(base, c, 'chrome-linux', 'chrome');
    if (fs.existsSync(ruta)) return ruta;
  }
  return undefined;
}

// ------------------------------------------------------------- servidor

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.json': 'application/json'
};

function servir() {
  const servidor = http.createServer((pedido, respuesta) => {
    const ruta = decodeURIComponent(new URL(pedido.url, 'http://localhost').pathname);
    const archivo = path.join(raiz, ruta.endsWith('/') ? ruta + 'index.html' : ruta);
    if (!archivo.startsWith(raiz) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      respuesta.writeHead(404);
      respuesta.end();
      return;
    }
    respuesta.writeHead(200, { 'content-type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
    fs.createReadStream(archivo).pipe(respuesta);
  });
  return new Promise((resolver) => servidor.listen(0, '127.0.0.1', () => resolver(servidor)));
}

// ----------------------------------------------------------- registro

const resultados = [];
const red = [];
const problemasConsola = [];

async function paso(nombre, fn) {
  try {
    await fn();
    resultados.push([true, nombre]);
    console.log('  bien   ' + nombre);
  } catch (error) {
    resultados.push([false, nombre, error]);
    console.log('  FALLA  ' + nombre + '\n         ' + String(error && error.message).split('\n').join('\n         '));
  }
}

async function nuevaPagina(navegador, opciones) {
  const contexto = await navegador.newContext(Object.assign({ reducedMotion: 'reduce', acceptDownloads: true, locale: 'es-EC' }, opciones));
  const pagina = await contexto.newPage();
  pagina.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problemasConsola.push(m.type() + ': ' + m.text());
  });
  pagina.on('pageerror', (e) => problemasConsola.push('error de la página: ' + e.message));
  pagina.on('request', (r) => red.push({ metodo: r.method(), url: r.url() }));
  return { contexto, pagina };
}

async function cargarEjemplo(pagina) {
  await pagina.click('#usar-ejemplo');
  await pagina.waitForFunction(() => document.querySelectorAll('#tabla-cuerpo tr.fila').length > 0 &&
    document.querySelector('#calculando').classList.contains('listo'));
}

async function fichas(pagina) {
  return pagina.$$eval('#resumen .ficha', (nodos) => nodos.map((n) => [
    n.querySelector('.ficha-etiqueta').textContent.trim(),
    n.querySelector('.ficha-valor').textContent.trim()
  ]));
}

async function textosColumna(pagina, indice) {
  return pagina.$$eval('#tabla-cuerpo tr.fila', (filas, i) => filas.map((f) => f.children[i].textContent.trim()), indice);
}

const numero = (texto) => Number(String(texto).replace(/\./g, '').replace(',', '.'));

async function esperarCalculo(pagina) {
  await pagina.waitForFunction(() => document.querySelector('#calculando').classList.contains('listo'));
}

async function irA(pagina, selector, margen = 12) {
  await pagina.evaluate(([s, m]) => {
    if (document.activeElement) document.activeElement.blur();
    const y = document.querySelector(s).getBoundingClientRect().top + window.scrollY - m;
    window.scrollTo(0, y);
  }, [selector, margen]);
  await pagina.waitForTimeout(150);
}

// --------------------------------------------------------------- prueba

const ejecutable = buscarNavegador();
const navegador = await chromium.launch(ejecutable ? { executablePath: ejecutable } : {});
const servidor = await servir();
const base = 'http://127.0.0.1:' + servidor.address().port + '/';
fs.mkdirSync(capturas, { recursive: true });
fs.mkdirSync(salida, { recursive: true });
console.log('Navegador: ' + (ejecutable || 'el de Playwright') + '\n');

// 1. Doble clic: la página abierta como archivo, en un escritorio.
console.log('Escritorio, abierta con doble clic (file://)');
{
  const { contexto, pagina } = await nuevaPagina(navegador, { viewport: { width: 1366, height: 900 }, colorScheme: 'light' });
  await pagina.goto('file://' + path.join(raiz, 'index.html'));

  await paso('la página abre sin datos y lo dice', async () => {
    assert.equal(await pagina.title(), 'Cuánto pedir');
    assert.ok(await pagina.isVisible('#resultados-vacio'));
    assert.ok(await pagina.isHidden('#resultados'));
  });
  await pagina.screenshot({ path: path.join(capturas, 'inicio.png') });

  await paso('los datos de ejemplo dan 33 productos: 10 para pedir, 19 bien y 4 quietos', async () => {
    await cargarEjemplo(pagina);
    assert.equal(await pagina.locator('#tabla-cuerpo tr.fila').count(), 33);
    assert.deepEqual(await fichas(pagina), [['Pedir ya', '10'], ['Están bien', '19'], ['No se mueven', '4']]);
    const periodo = await pagina.textContent('#periodo');
    assert.match(periodo, /180 días/);
    assert.match(periodo, /sábados ni los domingos/);
  });

  await paso('las columnas del historial se reconocieron por su nombre', async () => {
    const valores = await pagina.$$eval('[data-ranura="historial"] .mapa select', (s) => s.map((x) => x.selectedOptions[0].textContent));
    assert.deepEqual(valores.slice(0, 4), ['fecha', 'codigo', 'cantidad', 'producto']);
  });

  await paso('lo que hay que pedir va primero y con el acento', async () => {
    const estados = await textosColumna(pagina, 6);
    assert.deepEqual(estados.slice(0, 10), Array(10).fill('Pedir ahora'));
    assert.ok(!estados.slice(10).includes('Pedir ahora'));
    const color = await pagina.$eval('.estado-pedir', (n) => getComputedStyle(n).backgroundColor);
    assert.equal(color, 'rgb(181, 67, 15)');
  });

  await paso('el filtro «Solo lo que hay que pedir» y la búsqueda', async () => {
    await pagina.check('#f-pedir');
    assert.equal(await pagina.locator('#tabla-cuerpo tr.fila').count(), 10);
    await pagina.uncheck('#f-pedir');
    await pagina.fill('#f-texto', 'paracetamol');
    assert.equal(await pagina.locator('#tabla-cuerpo tr.fila').count(), 1);
    await pagina.fill('#f-texto', '');
    await pagina.selectOption('#f-tipo', 'esporadico');
    assert.equal(await pagina.locator('#tabla-cuerpo tr.fila').count(), 13);
    await pagina.selectOption('#f-tipo', 'todos');
  });

  await paso('ordenar por «Cuánto» de más a menos', async () => {
    await pagina.click('#tabla-titulos th:nth-child(8) button');
    const cuantos = (await textosColumna(pagina, 7)).filter(Boolean).map(numero);
    assert.equal(cuantos.length, 10);
    assert.deepEqual(cuantos, [...cuantos].sort((a, b) => b - a));
    await pagina.click('#tabla-titulos th:nth-child(7) button');
  });

  await paso('el detalle de un producto: la cuenta y sus dos gráficos', async () => {
    await pagina.fill('#f-texto', 'PT-001');
    await pagina.click('#tabla-cuerpo tr.fila .producto-boton');
    await pagina.waitForSelector('tr.detalle .lienzo svg');
    assert.equal(await pagina.locator('tr.detalle .lienzo svg').count(), 2);
    const texto = await pagina.textContent('tr.detalle');
    assert.match(texto, /Punto de pedido/);
    assert.match(texto, /se cubren \d+ de cada 100 esperas/);
    assert.equal(await pagina.getAttribute('#tabla-cuerpo tr.fila .producto-boton', 'aria-expanded'), 'true');
    await pagina.fill('#f-texto', '');
  });

  await paso('el CSV que se descarga trae la misma lista', async () => {
    const [descarga] = await Promise.all([pagina.waitForEvent('download'), pagina.click('#descargar-resultados')]);
    assert.match(descarga.suggestedFilename(), /^cuanto-pedir-\d{4}-\d{2}-\d{2}\.csv$/);
    const destino = path.join(salida, descarga.suggestedFilename());
    await descarga.saveAs(destino);
    const texto = fs.readFileSync(destino, 'utf8');
    const lineas = texto.trim().split(/\r?\n/);
    assert.ok(texto.startsWith('﻿Producto;Nombre;Tipo;Venta diaria;Colchón;Punto de pedido'));
    assert.equal(lineas.length, 34);
    assert.equal(lineas.filter((l) => l.split(';')[8] === 'Sí').length, 10);
  });

  await paso('al subir el nivel de servicio, el colchón crece y la tabla se rehace', async () => {
    const colchonAntes = await pagina.$$eval('#tabla-cuerpo tr.fila', (filas) => filas.map((f) => f.children[3].textContent));
    await pagina.fill('#p-nivel', '99');
    await pagina.waitForFunction((antes) => {
      const ahora = [...document.querySelectorAll('#tabla-cuerpo tr.fila')].map((f) => f.children[3].textContent);
      return ahora.join('|') !== antes.join('|');
    }, colchonAntes);
    await esperarCalculo(pagina);
    const pedir = Number((await fichas(pagina))[0][1]);
    assert.ok(pedir >= 10, 'con más servicio no deberían pedirse menos productos');
    await pagina.fill('#p-nivel', '95');
    await pagina.waitForFunction(() => document.querySelector('#resumen .ficha-valor').textContent.trim() === '10');
  });

  await paso('un valor imposible se señala y no rompe la cuenta', async () => {
    await pagina.fill('#p-plazo', 'diez');
    await pagina.waitForSelector('#e-p-plazo');
    assert.equal(await pagina.getAttribute('#p-plazo', 'aria-invalid'), 'true');
    assert.equal(await pagina.locator('#tabla-cuerpo tr.fila').count(), 33);
    await pagina.fill('#p-plazo', '10');
    await pagina.waitForSelector('#e-p-plazo', { state: 'detached' });
  });

  await paso('el nivel de servicio por costos: margen 1,00, costo 2,40 y 25 % dan 95,1 %', async () => {
    await pagina.click('text=Lo calculo con margen y costo');
    await pagina.waitForFunction(() => /95,1/.test(document.querySelector('#resultado-nivel').textContent));
    assert.match(await pagina.textContent('#resultado-nivel'), /USD 0,05/);
    await esperarCalculo(pagina);
    await pagina.click('text=Lo fijo yo');
    await esperarCalculo(pagina);
  });

  // Capturas de escritorio: el resultado y el detalle de dos productos.
  const abierto = pagina.locator('.producto-boton[aria-expanded="true"]');
  if (await abierto.count()) await abierto.click();
  await pagina.fill('#f-texto', '');
  await irA(pagina, '#paso-resultados', -24);
  await pagina.screenshot({ path: path.join(capturas, 'escritorio.png') });
  for (const [codigo, archivo] of [['PT-001', 'detalle-regular.png'], ['PT-018', 'detalle-esporadico.png']]) {
    await pagina.fill('#f-texto', codigo);
    await pagina.click('#tabla-cuerpo tr.fila .producto-boton');
    await pagina.waitForSelector('tr.detalle .lienzo svg');
    await pagina.waitForTimeout(200);
    await pagina.locator('tr.detalle').screenshot({ path: path.join(capturas, archivo) });
  }
  await pagina.fill('#f-texto', '');
  await contexto.close();
}

// 2. Servida por HTTP, como en GitHub Pages, con archivos de verdad.
console.log('\nEscritorio, servida por HTTP');
{
  const { contexto, pagina } = await nuevaPagina(navegador, { viewport: { width: 1280, height: 900 } });
  await pagina.goto(base);

  await paso('un CSV de Excel en Windows: punto y coma, coma decimal, kilos y tildes', async () => {
    await pagina.setInputFiles('#archivo-historial', path.join(datos, 'consumo-windows-1252.csv'));
    await pagina.waitForFunction(() => document.querySelectorAll('#tabla-cuerpo tr.fila').length === 4);
    await esperarCalculo(pagina);
    const valores = await pagina.$$eval('[data-ranura="historial"] .mapa select', (s) => s.map((x) => x.selectedOptions[0].textContent));
    assert.deepEqual(valores.slice(0, 4), ['Fecha', 'Código', 'Cantidad (kg)', 'Descripción']);
    const texto = await pagina.textContent('#tabla-cuerpo');
    assert.match(texto, /Almidón de maíz/);
    assert.ok(!texto.includes('�'), 'las tildes se leyeron mal');
    const fila = await pagina.$$eval('#tabla-cuerpo tr.fila', (filas) => filas.map((f) => [...f.children].map((c) => c.textContent.trim())));
    const lactosa = fila.find((f) => f[0].startsWith('MP-101'));
    assert.match(lactosa[2], /^\d+,\d$/, 'la venta diaria lleva coma decimal');
    assert.match(lactosa[4], /^\d+,\d{2}$/, 'el punto de pedido conserva los dos decimales de los kilos');
    assert.equal(fila.find((f) => f[0].startsWith('MP-103'))[1], 'Esporádico');
    assert.match(await pagina.textContent('#periodo'), /120 días/);
  });

  await paso('sin existencias, la cuenta da el punto de pedido y pide el archivo', async () => {
    assert.deepEqual((await fichas(pagina))[0], ['Pedir ya', '—']);
    assert.equal(await pagina.locator('.estado-falta').count(), 4);
  });

  await paso('una columna mal elegida se corrige con la lista', async () => {
    await pagina.selectOption('#col-historial-cantidad', '-1');
    await pagina.waitForSelector('#resultados-vacio:not([hidden])');
    assert.match(await pagina.textContent('#resultados-vacio'), /cantidad/);
    await pagina.selectOption('#col-historial-cantidad', '3');
    await pagina.waitForFunction(() => document.querySelectorAll('#tabla-cuerpo tr.fila').length === 4);
  });

  // Si hay internet, leer Excel tiene que funcionar; solo se omite sin conexión.
  let hayInternet = true;
  try {
    await fetch('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
  } catch (e) {
    hayInternet = false;
  }
  await paso('un Excel con fila de título, dos hojas y fechas de Excel', async () => {
    if (!hayInternet) return;
    await pagina.setInputFiles('#archivo-historial', path.join(datos, 'ventas.xlsx'));
    const resultado = await Promise.race([
      pagina.waitForFunction(() => document.querySelectorAll('#tabla-cuerpo tr.fila').length === 2 &&
        document.querySelector('#calculando').classList.contains('listo'), null, { timeout: 30000 }).then(() => 'tabla'),
      pagina.waitForSelector('[data-ranura="historial"] .error', { timeout: 30000 }).then(() => 'error')
    ]);
    if (resultado === 'error') throw new Error(await pagina.textContent('[data-ranura="historial"] .error'));
    assert.equal(await pagina.$eval('#hoja-historial', (s) => s.selectedOptions[0].textContent), 'Ventas');
    const valores = await pagina.$$eval('[data-ranura="historial"] .mapa select', (s) => s.map((x) => x.selectedOptions[0].textContent));
    assert.deepEqual(valores.slice(0, 3), ['Fecha', 'Artículo', 'Unidades']);
    const periodo = await pagina.textContent('#periodo');
    assert.match(periodo, /4 may 2026/);
    assert.match(periodo, /los domingos/);
    const tipos = await textosColumna(pagina, 1);
    assert.deepEqual(tipos.sort(), ['Esporádico', 'Regular']);
  });
  if (!hayInternet) console.log('         (sin internet: la lectura de Excel quedó sin probar)');
  await contexto.close();
}

// 3. Teléfono.
console.log('\nTeléfono');
{
  const { contexto, pagina } = await nuevaPagina(navegador, {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light'
  });
  await pagina.goto('file://' + path.join(raiz, 'index.html'));
  await pagina.screenshot({ path: path.join(capturas, 'telefono-inicio.png') });
  await paso('en el teléfono no hay desplazamiento horizontal', async () => {
    await cargarEjemplo(pagina);
    const [scroll, ancho] = await pagina.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= ancho, `la página mide ${scroll} px en una pantalla de ${ancho}`);
  });
  await paso('en el teléfono cada producto es una ficha', async () => {
    assert.equal(await pagina.isHidden('#tabla thead'), true);
    const etiqueta = await pagina.$eval('#tabla-cuerpo tr.fila td[data-etiqueta="Punto de pedido"]', (n) => getComputedStyle(n, '::before').content);
    assert.equal(etiqueta, '"Punto de pedido"');
  });
  await irA(pagina, '#paso-resultados', -8);
  await pagina.screenshot({ path: path.join(capturas, 'telefono.png') });
  await paso('en el teléfono el detalle se abre debajo de la ficha', async () => {
    await pagina.tap('#tabla-cuerpo tr.fila:nth-child(1) .producto-boton');
    await pagina.waitForSelector('tr.detalle .lienzo svg');
    const [scroll, ancho] = await pagina.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= ancho);
  });
  await irA(pagina, 'tr.detalle', 0);
  await pagina.screenshot({ path: path.join(capturas, 'telefono-detalle.png') });
  await contexto.close();
}

// 4. Modo oscuro.
console.log('\nModo oscuro');
{
  const { contexto, pagina } = await nuevaPagina(navegador, { viewport: { width: 1366, height: 900 }, colorScheme: 'dark' });
  await pagina.goto('file://' + path.join(raiz, 'index.html'));
  await paso('el modo oscuro sigue al sistema y se puede cambiar a mano', async () => {
    const fondo = () => pagina.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(await fondo(), 'rgb(28, 26, 46)');
    await pagina.click('#boton-tema');
    assert.equal(await fondo(), 'rgb(243, 239, 226)');
    await pagina.click('#boton-tema');
    assert.equal(await fondo(), 'rgb(28, 26, 46)');
  });
  await cargarEjemplo(pagina);
  await pagina.fill('#f-texto', 'PT-006');
  await pagina.click('#tabla-cuerpo tr.fila .producto-boton');
  await pagina.waitForSelector('tr.detalle .lienzo svg');
  await pagina.fill('#f-texto', '');
  await irA(pagina, '#paso-resultados', -24);
  await pagina.screenshot({ path: path.join(capturas, 'oscuro.png') });
  await pagina.locator('tr.detalle').screenshot({ path: path.join(capturas, 'oscuro-detalle.png') });
  await contexto.close();
}

// 5. Lo que salió a la red.
console.log('\nRed');
await paso('la página no envía nada: solo descarga tipografías y el lector de Excel', async () => {
  const externos = red.filter((r) => !r.url.startsWith('file:') && !r.url.startsWith(base) && !r.url.startsWith('blob:') && !r.url.startsWith('data:'));
  for (const r of externos) {
    assert.ok(PERMITIDOS.has(new URL(r.url).hostname), 'pedido a ' + r.url);
    assert.equal(r.metodo, 'GET', 'pedido ' + r.metodo + ' a ' + r.url);
  }
  assert.ok(red.every((r) => r.metodo === 'GET'));
});
await paso('sin errores en la consola', async () => {
  assert.deepEqual(problemasConsola, []);
});

await navegador.close();
servidor.close();

const fallas = resultados.filter((r) => !r[0]);
console.log('\n' + (resultados.length - fallas.length) + ' de ' + resultados.length + ' comprobaciones bien.');
console.log('Capturas en ' + path.relative(process.cwd(), capturas) + '/');
process.exit(fallas.length ? 1 : 0);
