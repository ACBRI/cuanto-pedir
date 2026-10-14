/*
 * Datos de ejemplo de Cuánto pedir: una empresa farmacéutica ficticia con 33
 * productos y 180 días de venta, de lunes a viernes. Unos se venden a diario,
 * otros de vez en cuando y cuatro no se movieron. Todo se genera con semilla
 * fija, así que siempre salen las mismas cifras. Los archivos de la carpeta
 * ejemplo/ son estos mismos datos, escritos por herramientas/escribir-ejemplo.js.
 */
(function (raiz, fabrica) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./calculo.js'));
  else raiz.Ejemplo = fabrica(raiz.Calculo);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  const SEMILLA = 2026;
  const INICIO = C.diaDeFecha(2026, 4, 6); // lunes
  const DIAS = 180;                         // hasta el viernes 2 de octubre de 2026
  const FERIADOS = [C.diaDeFecha(2026, 5, 1), C.diaDeFecha(2026, 8, 10)];

  const PROVEEDORES = {
    propia: ['Fabricación propia', 14],
    local: ['Proveedor local', 7],
    importado: ['Importación', 35]
  };

  // diario: unidades por día de trabajo. esporadico: probabilidad de vender un
  // día y unidades adicionales cuando se vende. cobertura: días de venta que
  // hay hoy en bodega. camino: lotes que ya vienen en camino.
  const PRODUCTOS = [
    { codigo: 'PT-001', nombre: 'Paracetamol 500 mg, caja x 100', diario: 38, cobertura: 12, proveedor: 'propia' },
    { codigo: 'PT-002', nombre: 'Ibuprofeno 400 mg, caja x 50', diario: 22, cobertura: 30, proveedor: 'propia' },
    { codigo: 'PT-003', nombre: 'Amoxicilina 500 mg, caja x 21', diario: 15, cobertura: 50, proveedor: 'importado' },
    { codigo: 'PT-004', nombre: 'Loratadina 10 mg, caja x 10', diario: 12, cobertura: 6 },
    { codigo: 'PT-005', nombre: 'Omeprazol 20 mg, caja x 14', diario: 18, cobertura: 25, proveedor: 'local' },
    { codigo: 'PT-006', nombre: 'Sales de rehidratación oral, sobre', diario: 30, cobertura: 5, proveedor: 'local' },
    { codigo: 'PT-007', nombre: 'Vitamina C 1 g efervescente, tubo x 10', diario: 9, cobertura: 22 },
    { codigo: 'PT-008', nombre: 'Jarabe para la tos, frasco 120 ml', diario: 7, cobertura: 8, camino: 1, proveedor: 'propia' },
    { codigo: 'PT-009', nombre: 'Alcohol antiséptico 70 %, frasco 500 ml', diario: 25, cobertura: 40, proveedor: 'local' },
    { codigo: 'PT-010', nombre: 'Gel antibacterial, frasco 250 ml', diario: 14, cobertura: 15, proveedor: 'local' },
    { codigo: 'PT-011', nombre: 'Suero fisiológico, frasco 500 ml', diario: 10, cobertura: 18 },
    { codigo: 'PT-012', nombre: 'Diclofenaco gel 1 %, tubo 50 g', diario: 6, cobertura: 9 },
    { codigo: 'PT-013', nombre: 'Complejo B, caja x 30', diario: 5, cobertura: 60, proveedor: 'importado' },
    { codigo: 'PT-014', nombre: 'Metformina 850 mg, caja x 30', diario: 8, cobertura: 35, proveedor: 'propia' },
    { codigo: 'PT-015', nombre: 'Losartán 50 mg, caja x 30', diario: 6, cobertura: 14, proveedor: 'propia' },
    { codigo: 'PT-016', nombre: 'Cetirizina 10 mg, caja x 10', diario: 4, cobertura: 26 },
    { codigo: 'PT-017', nombre: 'Azitromicina 500 mg, caja x 3', esporadico: [0.45, 3], cobertura: 70, proveedor: 'importado' },
    { codigo: 'PT-018', nombre: 'Clotrimazol crema 1 %, tubo 20 g', esporadico: [0.35, 2], cobertura: 6 },
    { codigo: 'PT-019', nombre: 'Prednisona 20 mg, caja x 10', esporadico: [0.3, 4], cobertura: 45, proveedor: 'importado' },
    { codigo: 'PT-020', nombre: 'Ácido fólico 1 mg, caja x 30', esporadico: [0.25, 5], cobertura: 30 },
    { codigo: 'PT-021', nombre: 'Hierro en jarabe, frasco 120 ml', esporadico: [0.2, 2], cobertura: 10, proveedor: 'propia' },
    { codigo: 'PT-022', nombre: 'Nistatina en suspensión, frasco 60 ml', esporadico: [0.15, 3], cobertura: 40 },
    { codigo: 'PT-023', nombre: 'Ketoconazol champú, frasco 120 ml', esporadico: [0.12, 1], cobertura: 0 },
    { codigo: 'PT-024', nombre: 'Lidocaína gel 2 %, tubo 30 g', esporadico: [0.1, 2], cobertura: 60 },
    { codigo: 'PT-025', nombre: 'Mebendazol en suspensión, frasco 30 ml', esporadico: [0.08, 6], cobertura: 90 },
    { codigo: 'PT-026', nombre: 'Sucralfato en suspensión, frasco 200 ml', esporadico: [0.06, 2], cobertura: 120 },
    { codigo: 'PT-027', nombre: 'Tobramicina gotas oftálmicas, frasco 5 ml', esporadico: [0.07, 12], cobertura: 20, proveedor: 'importado' },
    { codigo: 'PT-028', nombre: 'Hidrocortisona crema 1 %, tubo 15 g', esporadico: [0.18, 8], cobertura: 35 },
    { codigo: 'PT-029', nombre: 'Dexametasona 4 mg, ampolla', esporadico: [0.04, 25], cobertura: 200, proveedor: 'importado' },
    { codigo: 'PT-030', nombre: 'Vitamina E 400 UI, caja x 30', quieto: 40 },
    { codigo: 'PT-031', nombre: 'Talco medicado, frasco 100 g', quieto: 120 },
    { codigo: 'PT-032', nombre: 'Bálsamo mentolado, frasco 30 g', quieto: 15 },
    { codigo: 'PT-033', nombre: 'Crema de caléndula, tubo 60 g', quieto: 60 }
  ];

  /** Cuántas unidades salen un día, con promedio `lambda`. */
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

  function fechaLocal(dia) {
    const f = C.fechaDeDia(dia);
    return String(f.dia).padStart(2, '0') + '/' + String(f.mes).padStart(2, '0') + '/' + f.anio;
  }

  /** Genera los tres archivos de ejemplo como texto CSV (punto y coma, fechas día/mes/año). */
  function generar() {
    const azar = C.generador(SEMILLA);
    const lineas = [];
    const totales = new Map(PRODUCTOS.map((p) => [p.codigo, 0]));
    let documento = 4521;
    for (let k = 0; k < DIAS; k++) {
      const dia = INICIO + k;
      const s = C.diaSemana(dia);
      if (s === 0 || s === 6 || FERIADOS.includes(dia)) continue;
      for (const p of PRODUCTOS) {
        let cantidad = 0;
        if (p.diario) {
          cantidad = poisson(p.diario * (0.6 + 0.8 * azar()), azar);
        } else if (p.esporadico) {
          if (azar() < p.esporadico[0]) cantidad = 1 + poisson(p.esporadico[1], azar);
        }
        if (!cantidad) continue;
        totales.set(p.codigo, totales.get(p.codigo) + cantidad);
        // Una venta grande llega en varias facturas del mismo día.
        const partes = cantidad <= 3 ? 1 : 1 + Math.floor(azar() * 3);
        let resto = cantidad;
        for (let i = 0; i < partes; i++) {
          const parte = i === partes - 1 ? resto : Math.max(1, Math.round(resto * (0.3 + 0.4 * azar())));
          if (parte <= 0) break;
          resto -= parte;
          lineas.push({ dia, documento: documento++, p, cantidad: parte });
        }
      }
    }
    const historial = ['fecha;documento;codigo;producto;cantidad'];
    for (const l of lineas) {
      historial.push([fechaLocal(l.dia), 'FAC-001-' + String(l.documento).padStart(9, '0'), l.p.codigo, l.p.nombre, l.cantidad].join(';'));
    }

    const existencias = ['codigo;producto;existencias;en_camino'];
    for (const p of PRODUCTOS) {
      const ventaDiaria = totales.get(p.codigo) / DIAS;
      const hay = p.quieto !== undefined ? p.quieto : Math.round(ventaDiaria * p.cobertura);
      const camino = p.camino ? Math.ceil(ventaDiaria * 30 * p.camino) : 0;
      existencias.push([p.codigo, p.nombre, hay, camino].join(';'));
    }

    const plazos = ['codigo;proveedor;plazo_dias'];
    for (const p of PRODUCTOS) {
      if (!p.proveedor) continue;
      const [proveedor, dias] = PROVEEDORES[p.proveedor];
      plazos.push([p.codigo, proveedor, dias].join(';'));
    }

    return {
      historial: historial.join('\n') + '\n',
      existencias: existencias.join('\n') + '\n',
      plazos: plazos.join('\n') + '\n'
    };
  }

  return {
    NOMBRES: { historial: 'ejemplo-historial.csv', existencias: 'ejemplo-existencias.csv', plazos: 'ejemplo-plazos.csv' },
    PRODUCTOS: PRODUCTOS.length,
    DIAS,
    generar
  };
});
