// Aplica el modo claro u oscuro que la persona eligió antes, antes de pintar la
// página. Si no eligió ninguno, manda el de su sistema.
(function () {
  'use strict';
  try {
    var tema = window.localStorage.getItem('cuanto-pedir-tema');
    if (tema === 'light' || tema === 'dark') document.documentElement.setAttribute('data-theme', tema);
  } catch (e) {
    // Sin almacenamiento (ventana privada o archivo local bloqueado): queda el del sistema.
  }
})();
