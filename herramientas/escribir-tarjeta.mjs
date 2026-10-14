#!/usr/bin/env node
// Escribe docs/tarjeta.png (1200 x 630), la imagen que muestran LinkedIn y
// otras redes al compartir el enlace, a partir de docs/tarjeta.html.
//
//   npm run tarjeta

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function buscarNavegador() {
  if (process.env.NAVEGADOR) return process.env.NAVEGADOR;
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  for (const c of fs.readdirSync(base).sort().reverse().filter((x) => x.startsWith('chromium_headless_shell-'))) {
    const ruta = path.join(base, c, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (fs.existsSync(ruta)) return ruta;
  }
  return undefined;
}

const ejecutable = buscarNavegador();
const navegador = await chromium.launch(ejecutable ? { executablePath: ejecutable } : {});
const pagina = await navegador.newPage({ viewport: { width: 1200, height: 630 } });
await pagina.goto('file://' + path.join(raiz, 'docs', 'tarjeta.html'));
await pagina.evaluate(() => document.fonts.ready);
await pagina.waitForTimeout(300);
const destino = path.join(raiz, 'docs', 'tarjeta.png');
await pagina.screenshot({ path: destino });
await navegador.close();
console.log(path.relative(process.cwd(), destino));
