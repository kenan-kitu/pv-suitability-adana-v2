// --------------------
// Fixed assumptions (hide from user)
// --------------------
const PR_FIXED = 0.75;          // performance ratio
const EF_FIXED = 0.45;          // kgCO2 per kWh (grid emission factor)
const HH_FIXED = 2400;          // kWh/year per household (assumption)

// Dummy SR for now (replace later with your GIS zonal means)
const SR_HIGH = 1800;           // kWh/m2/year
const SR_MOD  = 1700;           // kWh/m2/year

// --------------------
// Map setup
// --------------------
const map = L.map('map').setView([37.0, 35.3], 8);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

const drawnItems = new L.FeatureGroup().addTo(map);

// Only polygon/rectangle drawing
const drawControl = new L.Control.Draw({
  draw: { polygon: true, rectangle: true, circle: false, circlemarker: false, marker: false, polyline: false },
  edit: { featureGroup: drawnItems }
});
map.addControl(drawControl);

const el = (id) => document.getElementById(id);
function fmt(num, digits=0){
  if (!isFinite(num)) return '—';
  return num.toLocaleString(undefined, { maximumFractionDigits: digits });
}

// --------------------
// Suitability layers (GeoJSON)
// You MUST add these files to repo:
// /data/high.geojson
// /data/mod.geojson
// --------------------
let highGeo = null;      // FeatureCollection
let modGeoRaw = null;    // FeatureCollection (may overlap with high)
let modGeo = null;       // FeatureCollection after removing overlap
let allowedGeo = null;   // currently selected allowed zone

let highLayer = null;
let modLayer = null;

// Fetch GeoJSON
async function loadSuitability() {
  // If you don't have data yet, keep placeholders off; but for restriction logic you need them.
  const [highResp, modResp] = await Promise.all([
    fetch('data/high.geojson'),
    fetch('data/mod.geojson')
  ]);

  highGeo = await highResp.json();
  modGeoRaw = await modResp.json();

  // --- Fix overlap: mod = modRaw - high (so they don't overlap)
  // Convert to single turf geometry using union where needed
  const highUnion = unionFeatureCollection(highGeo);
  const modUnion  = unionFeatureCollection(modGeoRaw);

  // If either is null, fallback
  if (highUnion && modUnion) {
    const diff = turf.difference(modUnion, highUnion);
    modGeo = diff ? turf.featureCollection([diff]) : turf.featureCollection([]);
  } else {
    modGeo = modGeoRaw;
  }

  // Draw on map
  highLayer = L.geoJSON(highGeo, { style: { color: '#00e5ff', weight: 2, fillOpacity: 0.12 } }).addTo(map);
  modLayer  = L.geoJSON(modGeo,  { style: { color: '#ffd500', weight: 2, fillOpacity: 0.10 } }).addTo(map);

  // Fit view to suitability extent
  const group = L.featureGroup([highLayer, modLayer]);
  map.fitBounds(group.getBounds(), { padding: [20, 20] });

  updateAllowedZone();
}

// Union helper: merge FeatureCollection polygons into one polygon/multipolygon
function unionFeatureCollection(fc) {
  try {
    const feats = fc?.features || [];
    if (feats.length === 0) return null;

    // Start with first polygon
    let u = feats[0];
    for (let i = 1; i < feats.length; i++) {
      const merged = turf.union(u, feats[i]);
      if (merged) u = merged;
    }
    return u;
  } catch (e) {
    return null;
  }
}

// --------------------
// Allowed zone logic
// --------------------
function updateAllowedZone() {
  const sel = el('suitSel').value;
  if (sel === 'high') {
    allowedGeo = unionFeatureCollection(highGeo);
  } else {
    allowedGeo = unionFeatureCollection(modGeo);
  }

  // Toggle visibility: show selected class stronger, the other lighter
  if (highLayer && modLayer) {
    const showHigh = (sel === 'high');
    highLayer.setStyle({ fillOpacity: showHigh ? 0.18 : 0.06, weight: showHigh ? 3 : 2 });
    modLayer.setStyle({ fillOpacity: !showHigh ? 0.16 : 0.05, weight: !showHigh ? 3 : 2 });
  }

  // Clear polygon when class changes to avoid invalid leftover
  clearPolygon();
  setStatus('Polygon: not drawn');
  resetKPIs();
}

function isPolygonInsideAllowed(polygonGeoJSON) {
  if (!allowedGeo) return false;

  // We require "fully inside": polygon within allowed zone
  // Use booleanWithin on turf polygon feature
  try {
    const poly = polygonGeoJSON; // GeoJSON feature
    return turf.booleanWithin(poly, allowedGeo);
  } catch {
    return false;
  }
}

function warnOutside() {
  // Simple popup + alert (you can keep only one if you want)
  L.popup()
    .setLatLng(map.getCenter())
    .setContent('<b>Invalid polygon</b><br/>Please draw fully inside the selected suitable area.')
    .openOn(map);

  alert('Invalid polygon. Please draw fully inside the selected suitable area.');
}

// --------------------
// Drawing events
// --------------------
map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  const gj = layer.toGeoJSON();

  // Validate against allowed zone
  if (!isPolygonInsideAllowed(gj)) {
    warnOutside();
    return; // do not add it
  }

  // Accept only one polygon
  drawnItems.clearLayers();
  drawnItems.addLayer(layer);

  setStatus('Polygon: accepted (inside suitable zone)');
  computeAndUpdate();
});

map.on('draw:edited', () => {
  const layers = drawnItems.getLayers();
  if (layers.length === 0) return;

  const gj = layers[0].toGeoJSON();
  if (!isPolygonInsideAllowed(gj)) {
    warnOutside();
    // revert by clearing (simple approach)
    clearPolygon();
    resetKPIs();
    setStatus('Polygon removed (it was outside suitable zone)');
    return;
  }

  setStatus('Polygon updated (still valid)');
  computeAndUpdate();
});

// --------------------
// KPI calculation
// --------------------
function computeAndUpdate() {
  const layers = drawnItems.getLayers();
  if (layers.length === 0) return;

  const polygon = layers[0].toGeoJSON();

  // Area
  const areaM2 = turf.area(polygon);
  const areaKm2 = areaM2 / 1_000_000;

  // Efficiency
  const eff = parseFloat(el('panelTech').value);

  // SR by selection
  const sel = el('suitSel').value;
  const sr = (sel === 'high') ? SR_HIGH : SR_MOD;

  // Energy (kWh/year) = SR(kWh/m²/yr) * Area(m²) * eff * PR
  const energyKWh = sr * areaM2 * eff * PR_FIXED;

  // Households served
  const homes = energyKWh / HH_FIXED;

  // Avoided CO2
  const co2Kg = energyKWh * EF_FIXED;

  el('areaKpi').textContent = `${fmt(areaKm2, 3)} km²`;
  el('srKpi').textContent = fmt(sr, 0);
  el('energyKpi').textContent = fmt(energyKWh, 0);
  el('homeKpi').textContent = fmt(homes, 0);
  el('co2Kpi').textContent = fmt(co2Kg, 0);
}

function resetKPIs() {
  ['areaKpi','srKpi','energyKpi','homeKpi','co2Kpi'].forEach(id => el(id).textContent = '—');
}

function setStatus(txt) {
  el('statusLine').textContent = txt;
}

function clearPolygon() {
  drawnItems.clearLayers();
}

// --------------------
// UI events
// --------------------
el('panelTech').addEventListener('input', () => computeAndUpdate());
el('suitSel').addEventListener('input', () => updateAllowedZone());
el('clearPoly').addEventListener('click', () => { clearPolygon(); resetKPIs(); setStatus('Polygon: not drawn'); });

// --------------------
// Start
// --------------------
resetKPIs();
setStatus('Loading suitability layers...');
loadSuitability()
  .then(() => setStatus('Polygon: not drawn'))
  .catch(() => {
    setStatus('Could not load GeoJSON. Add /data/high.geojson and /data/mod.geojson');
    alert('GeoJSON files missing: please add data/high.geojson and data/mod.geojson to the repo.');
  });
