/**
 * Der Block, den die Vereinsseite einfügt, um die Microsite einzubetten:
 * Rahmen, Ausweichlink und das Skript für die Höhe. Die Einstellungsseite
 * zeigt ihn mit der eigenen Adresse zum Kopieren; die README zeigt ihn für
 * `https://app.woelfe-voreifel.de`, und `settings.test.ts` hält beide gleich.
 * `einbettung.e2e.ts` lässt genau diesen Block in Chromium laufen.
 */
export function einbettungsBlock(herkunft: string, opts: { kompakt?: boolean; farbe?: 'dunkel' | 'hell' | null } = {}): string {
  const h = herkunft.replace(/\/+$/, '');
  const parameter = [opts.kompakt === false ? null : 'kompakt=1', opts.farbe ? `farbe=${opts.farbe}` : null].filter(Boolean).join('&');
  const quelle = `${h}/${parameter ? `?${parameter}` : ''}`;
  return `<!-- Wölfe live: Rahmen, Ausweichlink und Skript gehören zusammen in denselben HTML-Block. -->
<iframe id="woelfe-live" src="${quelle}"
  title="Wölfe live - Handball im Revier" loading="lazy"
  style="display:block;width:100%;height:1400px;border:0"></iframe>
<p style="text-align:center;font-size:.9em">Die Übersicht lädt nicht? <a href="${h}/" target="_blank" rel="noopener">Wölfe live direkt öffnen</a></p>
<script>
(function () {
  var HERKUNFT = '${h}'; // Adresse der Microsite, ohne Pfad und ohne Schrägstrich am Ende
  var KOPF = 60; // Höhe einer fest stehenden Kopfleiste der Vereinsseite in Pixeln (ohne: 0)
  var rahmen = document.getElementById('woelfe-live');
  if (!rahmen) return;
  var seiten = 0, geplant = false;
  // Welcher Teil des Rahmens gerade zu sehen ist: Danach richten sich Fenster und Hinweise im Rahmen.
  function sicht() {
    geplant = false;
    var r = rahmen.getBoundingClientRect();
    if (rahmen.contentWindow) rahmen.contentWindow.postMessage({ quelle: 'woelfe-live', typ: 'sicht', oben: Math.max(0, KOPF - r.top), hoehe: Math.max(100, window.innerHeight - KOPF) }, HERKUNFT);
  }
  function planen() { if (!geplant) { geplant = true; requestAnimationFrame(sicht); } }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (ev.origin !== HERKUNFT || ev.source !== rahmen.contentWindow || !d || d.quelle !== 'woelfe-live') return;
    // Die Höhe des Inhalts: Der Rahmen wächst mit, es gibt keinen zweiten Scrollbalken.
    if (d.typ === 'hoehe' && d.hoehe > 0 && d.hoehe < 50000) rahmen.style.height = Math.ceil(d.hoehe) + 'px';
    // Eine neue Seite im Rahmen (nicht die erste): zurück zum Anfang des Rahmens, falls er oben aus dem Bild ist.
    if (d.typ === 'seite') {
      seiten += 1;
      var oben = rahmen.getBoundingClientRect().top;
      if (seiten > 1 && oben < KOPF) window.scrollTo(0, window.pageYOffset + oben - KOPF);
    }
    planen();
  });
  window.addEventListener('scroll', planen, { passive: true });
  window.addEventListener('resize', planen);
})();
</script>`;
}
