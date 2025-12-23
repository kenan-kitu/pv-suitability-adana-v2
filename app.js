// =====================
// 1) Dummy suitable areas (replace with your real GeoJSON later)
//    Properties needed per feature:
//    - class: "HS" or "MS"
//    - sr_mean: annual solar radiation mean (kWh/m²/year) for that zone
// =====================
const suitableAreas = {
  "type":"FeatureCollection",
  "features":[
    // Dummy HS polygon near Adana (approx)
    {
      "type":"Feature",
      "properties":{"class":"HS","sr_mean": 1850, "name":"HS Zone A"},
      "geometry":{
        "type":"Polygon",
        "coordinates":[[
          [35.00, 37.10],
          [35.25, 37.10],
          [35.25, 37.30],
          [35.00, 37.30],
          [35.00, 37.10]
        ]]
      }
    },
    // Dummy MS polygon near Adana (approx)
    {
      "type":"Feature",
      "properties":{"class":"MS","sr_mean": 1700, "name":"MS Zone B"},
      "geometry":{
        "type":"Polygon",
        "coordinates":[[
          [35.20, 36.95],
          [35.55, 36.95],
          [35.55, 37.18],
          [35.20, 37.18],
          [35.20, 36.95]
        ]]
      }
    }
  ]
};

// =====================
// 2) Panel technologies (examples)
//    Efficiency should be fraction (0.131 not 13.1)
// =====================
const panelTechnologies = [
  { id: "cSi", label: "c-Si (13.1%)", eta: 0.131 },
  { id: "aSi", label: "a-Si (7.9%)", eta: 0.079 },
  { id: "CdTe", label: "CdTe (8.8%)", eta: 0.088 },
  { id: "CIGS", label: "CIGS (8.4%)", eta: 0.084 },
  { id: "CPV", label: "CPV (26.3%)", eta: 0.263 }
];

// =====================
// 3) Map init
// =====================
const map = L.map("map").setView([37.0, 35.32], 9);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// Suitable layer style
function styleByClass(cls) {
  if (cls === "HS") return { color: "#7a1fa2", weight: 2, fillOpacity: 0.35 };
  if (cls === "MS") return { color: "#ff7a00", weight: 2, fillOpacity: 0.30 };
  return { color: "#333", weight: 1, fillOpacity: 0.2 };
}

const suitableLayer = L.geoJSON(suitableAreas, {
  style: (f) => styleByClass(f.properties.class),
  onEachFeature: (f, layer) => {
    const p = f.properties;
    layer.bindPopup(
      `<b>${p.name || "Suitable Area"}</b><br/>Class: ${p.class}<br/>SR mean: ${p.sr_mean} kWh/m²/yr`
    );
  }
}).addTo(map);

// Fit bounds
map.fitBounds(suitableLayer.getBounds());

// =====================
// 4) Draw layer
// =====================
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

map.on(L.Draw.Event.CREATED, function (event) {
  // keep only last drawn polygon for simplicity
  drawnItems.clearLayers();
  drawnItems.addLayer(event.layer);
});

// =====================
// 5) UI setup
// =====================
const panelTechEl = document.getElementById("panelTech");
panelTechnologies.forEach(t => {
  const opt = document.createElement("option");
  opt.value = t.id;
  opt.textContent = t.label;
  panelTechEl.appendChild(opt);
});
panelTechEl.value = "cSi";

document.getElementById("recalc").addEventListener("click", recalc);

// =====================
// 6) Core computation
//    - We intersect user polygon with suitable polygons (HS/MS)
//    - Compute weighted SR mean by intersection area
//    - Apply coverage ratio to intersection area (deployable portion)
// =====================
function recalc() {
  const resEl = document.getElementById("results");

  if (drawnItems.getLayers().length === 0) {
    resEl.innerHTML = `<b>No polygon found.</b><br/><span class="muted">Draw a polygon first.</span>`;
    return;
  }

  // Read inputs
  const techId = panelTechEl.value;
  const tech = panelTechnologies.find(t => t.id === techId);
  const pr = clamp(parseFloat(document.getElementById("pr").value), 0, 1);
  const coveragePct = clamp(parseFloat(document.getElementById("coverage").value), 0, 100);
  const coverage = coveragePct / 100.0;
  const classPick = document.getElementById("classPick").value;
  const hh = Math.max(1, parseFloat(document.getElementById("hh").value));
  const ef = Math.max(0, parseFloat(document.getElementById("ef").value));

  // Get drawn geometry as GeoJSON and convert to Turf feature
  const drawnGeo = drawnItems.getLayers()[0].toGeoJSON();

  // Ensure polygon (rectangle also polygon)
  const userPoly = drawnGeo;

  // Filter suitable features by class selection
  const allowed = suitableAreas.features.filter(f => {
    if (classPick === "HS") return f.properties.class === "HS";
    if (classPick === "MS") return f.properties.class === "MS";
    return f.properties.class === "HS" || f.properties.class === "MS";
  });

  let totalIntersectArea_m2 = 0;
  let srAreaSum = 0; // sum(sr_mean * area)

  for (const f of allowed) {
    const inter = safeIntersect(userPoly, f);
    if (!inter) continue;

    const a = turf.area(inter); // m²
    if (a <= 0) continue;

    totalIntersectArea_m2 += a;
    srAreaSum += (f.properties.sr_mean * a);
  }

  if (totalIntersectArea_m2 === 0) {
    resEl.innerHTML = `<b>No overlap with selected suitable areas.</b><br/>
      <span class="muted">Try drawing over the colored zones (HS/MS).</span>`;
    return;
  }

  // Weighted SR mean over overlapped suitable areas
  const srWeighted = srAreaSum / totalIntersectArea_m2; // kWh/m²/yr

  // Apply coverage (deployable portion)
  const usedArea_m2 = totalIntersectArea_m2 * coverage;

  // Annual energy (kWh/yr)
  const energy_kWh = srWeighted * usedArea_m2 * tech.eta * pr;

  // Household equivalent
  const households = energy_kWh / hh;

  // CO2 saved (tons/yr) - simplified
  const co2_kg = energy_kWh * ef;
  const co2_ton = co2_kg / 1000.0;

  // Pretty outputs
  const totalOverlap_km2 = totalIntersectArea_m2 / 1e6;
  const used_km2 = usedArea_m2 / 1e6;
  const energy_GWh = energy_kWh / 1e6;

  resEl.innerHTML = `
    <b>Computed results</b><br/><br/>
    <b>Selected tech:</b> ${tech.label} (η=${tech.eta.toFixed(3)})<br/>
    <b>PR:</b> ${pr.toFixed(2)} &nbsp; | &nbsp; <b>Coverage:</b> ${coveragePct.toFixed(0)}%<br/>
    <b>Suitability class:</b> ${classPick}<br/><br/>

    <b>Overlap suitable area:</b> ${format(totalOverlap_km2)} km²<br/>
    <b>Used area (coverage applied):</b> ${format(used_km2)} km²<br/>
    <b>Weighted SR mean:</b> ${format(srWeighted)} kWh/m²/year<br/><br/>

    <b>Annual energy:</b> ${format(energy_GWh)} GWh/year<br/>
    <b>Households supplied:</b> ${format(households)} households/year<br/>
    <b>CO₂ avoided:</b> ${format(co2_ton)} tons/year
    <br/><br/>
    <span class="muted">Note: This is a scenario-based estimate using simplified assumptions.</span>
  `;
}

// Helpers
function clamp(x, lo, hi) {
  if (Number.isNaN(x)) return lo;
  return Math.min(Math.max(x, lo), hi);
}

function format(x) {
  return (Math.round(x * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Turf intersect can fail on some edge cases; keep it safe
function safeIntersect(a, b) {
  try {
    return turf.intersect(a, b);
  } catch (e) {
    return null;
  }
}
