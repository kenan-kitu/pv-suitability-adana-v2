// ---- Map setup ----
const map = L.map('map').setView([37.0, 35.3], 8); // Adana-ish view
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const drawControl = new L.Control.Draw({
  draw: {
    polygon: true,
    rectangle: true,
    circle: false,
    circlemarker: false,
    marker: false,
    polyline: false
  },
  edit: {
    featureGroup: drawnItems
  }
});
map.addControl(drawControl);

let lastPolygonGeoJSON = null;

map.on(L.Draw.Event.CREATED, (e) => {
  drawnItems.clearLayers(); // only keep one polygon for simplicity
  const layer = e.layer;
  drawnItems.addLayer(layer);
  lastPolygonGeoJSON = layer.toGeoJSON();
  updatePolygonStatus(true);
  recalc();
});

map.on('draw:edited', () => {
  const layers = drawnItems.getLayers();
  if (layers.length > 0) {
    lastPolygonGeoJSON = layers[0].toGeoJSON();
    updatePolygonStatus(true);
    recalc();
  }
});

function updatePolygonStatus(isDrawn) {
  const pill = document.getElementById('polyStatus');
  if (isDrawn) {
    pill.textContent = 'Polygon: drawn (area is used)';
    pill.classList.add('ok');
  } else {
    pill.textContent = 'Polygon: not drawn';
    pill.classList.remove('ok');
  }
}

// ---- UI helpers ----
const el = (id) => document.getElementById(id);

function fmt(num, digits = 0) {
  if (!isFinite(num)) return '—';
  return num.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// ---- Core calculation ----
function getPolygonAreaM2() {
  if (!lastPolygonGeoJSON) return null;
  try {
    return turf.area(lastPolygonGeoJSON); // m²
  } catch {
    return null;
  }
}

function weightedSR(suitSel, srHigh, srMod) {
  // For now: simple choice.
  // Later: replace with GIS zonal mean for the selected class/area.
  if (suitSel === 'high') return srHigh;
  // high_mod -> average of both (simple). You can later weight by area.
  return (srHigh + srMod) / 2;
}

function availableAreaM2(areaMode, suitSel, presetHighKm2, presetModKm2) {
  if (areaMode === 'polygon') {
    const a = getPolygonAreaM2();
    return a; // may be null
  }

  // preset mode: convert km² to m² and sum based on suit selection
  const highM2 = presetHighKm2 * 1_000_000;
  const modM2  = presetModKm2  * 1_000_000;
  if (suitSel === 'high') return highM2;
  return highM2 + modM2;
}

function recalc() {
  const eff = parseFloat(el('panelTech').value);   // 0-1
  const pr = parseFloat(el('pr').value);           // 0-1
  const ef = parseFloat(el('ef').value);           // kgCO2/kWh
  const hh = parseFloat(el('hh').value);           // kWh/yr

  const suitSel = el('suitSel').value;
  const covPct = parseFloat(el('coverage').value);
  el('covLabel').textContent = covPct.toString();
  const coverage = covPct / 100.0;

  const srHigh = parseFloat(el('srHigh').value);   // kWh/m2/yr
  const srMod  = parseFloat(el('srMod').value);    // kWh/m2/yr

  const areaMode = el('areaMode').value;
  const presetHighKm2 = parseFloat(el('areaHigh').value);
  const presetModKm2  = parseFloat(el('areaMod').value);

  const availM2 = availableAreaM2(areaMode, suitSel, presetHighKm2, presetModKm2);

  // If polygon mode but no polygon, show guidance
  if (areaMode === 'polygon' && (!availM2 || availM2 <= 0)) {
    el('usedArea').textContent = '—';
    el('usedAreaNote').textContent = 'Draw a polygon on the map';
    el('srUsed').textContent = fmt(weightedSR(suitSel, srHigh, srMod), 0);
    el('energy').textContent = '—';
    el('homes').textContent = '—';
    el('co2').textContent = '—';
    updatePolygonStatus(!!lastPolygonGeoJSON);
    return;
  }

  const srUsed = weightedSR(suitSel, srHigh, srMod);

  // used area = available area * coverage ratio
  const usedM2 = (availM2 || 0) * coverage;

  // Energy = SR * Area * Eff * PR
  const energyKWh = srUsed * usedM2 * eff * pr;

  const homes = (hh > 0) ? (energyKWh / hh) : NaN;
  const co2Kg = energyKWh * ef;

  el('usedArea').textContent = `${fmt(usedM2 / 1_000_000, 2)} km²`;
  el('usedAreaNote').textContent =
    areaMode === 'polygon'
      ? `Polygon area: ${fmt((availM2 || 0) / 1_000_000, 2)} km²`
      : `Available area (preset): ${fmt((availM2 || 0) / 1_000_000, 2)} km²`;

  el('srUsed').textContent = fmt(srUsed, 0);
  el('energy').textContent = fmt(energyKWh, 0);
  el('homes').textContent = fmt(homes, 0);
  el('co2').textContent = fmt(co2Kg, 0);

  updatePolygonStatus(!!lastPolygonGeoJSON);
}

// Buttons
el('recalc').addEventListener('click', recalc);

el('clearPoly').addEventListener('click', () => {
  drawnItems.clearLayers();
  lastPolygonGeoJSON = null;
  updatePolygonStatus(false);
  recalc();
});

// Recalc on any input changes
[
  'panelTech','pr','ef','hh','suitSel','coverage','srHigh','srMod','areaMode','areaHigh','areaMod'
].forEach(id => el(id).addEventListener('input', recalc));

// Initial run
updatePolygonStatus(false);
recalc();
