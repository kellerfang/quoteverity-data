import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { unzipSync, strFromU8 } from "fflate";

const URLS = {
  blsApi: "https://api.bls.gov/publicAPI/v2/timeseries/data/",
  blsTables: "https://www.bls.gov/oes/tables.htm",
  eiaElectricity: "https://api.eia.gov/v2/electricity/retail-sales/data/",
  eiaGas: "https://api.eia.gov/v2/natural-gas/pri/sum/data/",
  energyStarGas: "https://data.energystar.gov/resource/6sbi-yuk2.json?$limit=50000",
  energyStarHeatPump: "https://data.energystar.gov/resource/v7jr-74b4.json?$limit=50000",
  zipCsv: "https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv",
  beaMetroRpp: "https://apps.bea.gov/regional/zip/MARPP.zip",
  beaStateRpp: "https://apps.bea.gov/regional/zip/SARPP.zip",
};

const TRADES = {
  plumbing: "47-2152",
  electrical: "47-2111",
  hvac: "49-9021",
  tree: "37-3013",
};

const STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","PR",
]);

const STATE_FIPS = {
  AL:"01",AK:"02",AZ:"04",AR:"05",CA:"06",CO:"08",CT:"09",DE:"10",DC:"11",FL:"12",GA:"13",HI:"15",ID:"16",IL:"17",IN:"18",IA:"19",KS:"20",KY:"21",LA:"22",ME:"23",MD:"24",MA:"25",MI:"26",MN:"27",MS:"28",MO:"29",MT:"30",NE:"31",NV:"32",NH:"33",NJ:"34",NM:"35",NY:"36",NC:"37",ND:"38",OH:"39",OK:"40",OR:"41",PA:"42",RI:"44",SC:"45",SD:"46",TN:"47",TX:"48",UT:"49",VT:"50",VA:"51",WA:"53",WV:"54",WI:"55",WY:"56",PR:"72",
};
const FIPS_STATE = Object.fromEntries(Object.entries(STATE_FIPS).map(([state, fips]) => [fips, state]));

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchChecked(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "User-Agent": "QuoteVerityDataBot/1.0 (+https://quoteverity.com/methodology)",
          Accept: "*/*",
          ...options.headers,
        },
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 2500);
    }
  }
  throw new Error(`Unable to fetch ${url}: ${lastError}`);
}

const asNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const round = (value, digits = 4) => Number(value.toFixed(digits));
const median = (values) => {
  const clean = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
};

const blsSeriesId = (state, occupation) => `OEU${state ? "S" : "N"}${state ? `${STATE_FIPS[state]}${"0".repeat(5)}` : "0".repeat(7)}${"0".repeat(6)}${occupation.replace("-", "")}08`;

async function fetchBlsBatch(seriesIds, releaseYear) {
  const response = await fetchChecked(URLS.blsApi, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seriesid: seriesIds, startyear: releaseYear, endyear: releaseYear }),
  });
  const payload = await response.json();
  if (payload.status !== "REQUEST_SUCCEEDED" || !Array.isArray(payload.Results?.series)) throw new Error(`BLS API request failed: ${JSON.stringify(payload.message ?? [])}`);
  return Object.fromEntries(payload.Results.series.map((series) => [series.seriesID, asNumber(series.data?.[0]?.value)]));
}

async function currentBlsRelease() {
  const html = await (await fetchChecked(URLS.blsTables)).text();
  const releases = [...html.matchAll(/May\s+(20\d{2})/gi)].map((match) => Number(match[1])).filter((year) => year >= 2020 && year <= new Date().getUTCFullYear());
  const year = Math.max(...releases);
  if (!Number.isFinite(year)) throw new Error("Unable to identify the current BLS OEWS May release");
  return { year: String(year), label: `May ${year}` };
}

async function fetchBlsLabor(previousLabor) {
  const release = await currentBlsRelease();
  if (previousLabor?.release === release.label
    && Object.keys(previousLabor.stateFactors ?? {}).length >= 51
    && Object.keys(previousLabor.nationalHourlyMedian ?? {}).length === Object.keys(TRADES).length) {
    return previousLabor;
  }
  const nationalIds = Object.values(TRADES).map((occupation) => blsSeriesId(null, occupation));
  const stateIds = [...STATE_CODES].flatMap((state) => Object.values(TRADES).map((occupation) => blsSeriesId(state, occupation)));
  const values = { ...await fetchBlsBatch(nationalIds, release.year) };
  for (let index = 0; index < stateIds.length; index += 25) Object.assign(values, await fetchBlsBatch(stateIds.slice(index, index + 25), release.year));

  const nationalHourlyMedian = Object.fromEntries(Object.entries(TRADES).map(([trade, occupation]) => {
    const wage = values[blsSeriesId(null, occupation)];
    if (!wage || wage < 10 || wage > 100) throw new Error(`Missing national BLS hourly median for ${trade} (${occupation})`);
    return [trade, round(wage, 2)];
  }));
  const stateFactors = {};
  for (const state of STATE_CODES) {
    stateFactors[state] = Object.fromEntries(Object.entries(TRADES).map(([trade, occupation]) => {
      const wage = values[blsSeriesId(state, occupation)] ?? nationalHourlyMedian[trade];
      return [trade, round(clamp(wage / nationalHourlyMedian[trade], 0.6, 1.7))];
    }));
  }
  return { release: release.label, statistic: "Hourly median wage", dataTypeCode: "08", nationalHourlyMedian, stateFactors };
}

async function fetchEia() {
  const electricityQuery = new URLSearchParams({ api_key: "DEMO_KEY", frequency: "monthly", start: "2025-01", offset: "0", length: "5000" });
  electricityQuery.append("data[0]", "price");
  electricityQuery.append("facets[sectorid][]", "RES");
  electricityQuery.append("sort[0][column]", "period");
  electricityQuery.append("sort[0][direction]", "desc");
  const electricity = await (await fetchChecked(`${URLS.eiaElectricity}?${electricityQuery}`)).json();

  const gasQuery = new URLSearchParams({ api_key: "DEMO_KEY", frequency: "monthly", start: "2025-01", offset: "0", length: "5000" });
  gasQuery.append("data[0]", "value");
  gasQuery.append("facets[process][]", "PRS");
  gasQuery.append("sort[0][column]", "period");
  gasQuery.append("sort[0][direction]", "desc");
  const gas = await (await fetchChecked(`${URLS.eiaGas}?${gasQuery}`)).json();

  const latestElectricity = {};
  for (const row of electricity.response.data) {
    const state = String(row.stateid ?? "");
    const price = asNumber(row.price);
    if (STATE_CODES.has(state) && price && !latestElectricity[state]) latestElectricity[state] = { value: price, period: row.period };
  }
  const latestGas = {};
  for (const row of gas.response.data) {
    const state = String(row.duoarea ?? "").replace(/^S/, "");
    const price = asNumber(row.value);
    if (STATE_CODES.has(state) && price && !latestGas[state]) latestGas[state] = { value: price, period: row.period };
  }

  const electricityFallback = median(Object.values(latestElectricity).map((row) => row.value));
  const gasFallback = median(Object.values(latestGas).map((row) => row.value));
  const states = {};
  for (const state of STATE_CODES) {
    const electric = latestElectricity[state] ?? { value: electricityFallback, period: "latest available state median" };
    const naturalGas = latestGas[state] ?? { value: gasFallback, period: "latest available state median" };
    states[state] = {
      electricityCentsPerKwh: round(electric.value, 2),
      electricityPeriod: electric.period,
      electricityFallback: !latestElectricity[state],
      naturalGasDollarsPerMcf: round(naturalGas.value, 2),
      naturalGasPeriod: naturalGas.period,
      naturalGasFallback: !latestGas[state],
    };
  }
  return { states };
}

function aggregateCertifiedProducts(rows, kind) {
  const usRows = rows.filter((row) => String(row.markets ?? "United States").includes("United States"));
  const capacityBands = {
    compact: usRows.filter((row) => asNumber(row.storage_volume_gallons) && asNumber(row.storage_volume_gallons) < 45),
    standard: usRows.filter((row) => asNumber(row.storage_volume_gallons) >= 45 && asNumber(row.storage_volume_gallons) <= 60),
    large: usRows.filter((row) => asNumber(row.storage_volume_gallons) > 60),
  };
  const annualField = kind === "heat-pump" ? "electric_usage_kwh_yr" : "therms_year_for_natural_gas";
  return {
    count: usRows.length,
    medianUef: round(median(usRows.map((row) => asNumber(row.uniform_energy_factor_uef))) ?? 0, 2),
    medianAnnualUse: round(median(usRows.map((row) => asNumber(row[annualField]))) ?? 0, 1),
    annualUseUnit: kind === "heat-pump" ? "kWh/year" : "therms/year",
    capacityBands: Object.fromEntries(Object.entries(capacityBands).map(([band, bandRows]) => [band, {
      count: bandRows.length,
      medianUef: round(median(bandRows.map((row) => asNumber(row.uniform_energy_factor_uef))) ?? 0, 2),
      medianAnnualUse: round(median(bandRows.map((row) => asNumber(row[annualField]))) ?? 0, 1),
    }])),
  };
}

async function fetchCertifiedProducts() {
  const [gasRows, heatPumpRows] = await Promise.all([
    (await fetchChecked(URLS.energyStarGas)).json(),
    (await fetchChecked(URLS.energyStarHeatPump)).json(),
  ]);
  return {
    gasWaterHeaters: aggregateCertifiedProducts(gasRows, "gas"),
    heatPumpWaterHeaters: aggregateCertifiedProducts(heatPumpRows, "heat-pump"),
  };
}

async function fetchGeography() {
  const csv = await (await fetchChecked(URLS.zipCsv)).text();
  const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true });
  const stateByZip = {};
  for (const row of rows) {
    const zip = String(row.zip_code ?? "").padStart(5, "0");
    const state = String(row.state ?? "").toUpperCase();
    if (/^\d{5}$/.test(zip) && STATE_CODES.has(state)) stateByZip[zip] = state;
  }
  return { zipCount: Object.keys(stateByZip).length, stateByZip };
}

const normalizeBeaArea = (value) => String(value ?? "")
  .replace(/\s*\*\s*$/, "")
  .replace(/\s*\(Metropolitan Statistical Area\)\s*$/i, "")
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "");

function archiveFromBytes(bytes) {
  return unzipSync(new Uint8Array(bytes));
}

function csvFromArchive(archive, prefix) {
  const filename = Object.keys(archive).find((name) => name.startsWith(`${prefix}_`) && name.endsWith(".csv"));
  if (!filename) throw new Error(`${prefix} CSV is missing from the BEA archive`);
  return strFromU8(archive[filename]);
}

function releaseFromArchive(archive, prefix) {
  const filename = Object.keys(archive).find((name) => name === `${prefix}__Footnotes.html`);
  const footnotes = filename ? strFromU8(archive[filename]) : "";
  const match = footnotes.match(/Last updated:\s*([^<\-]+)--\s*new statistics for\s*(\d{4})/i);
  return match ? { releaseDate: match[1].trim(), year: match[2] } : null;
}

async function fetchBeaRegionalPrices() {
  const [metroResponse, stateResponse] = await Promise.all([
    fetchChecked(URLS.beaMetroRpp),
    fetchChecked(URLS.beaStateRpp),
  ]);
  const [metroBytes, stateBytes] = await Promise.all([
    metroResponse.arrayBuffer(),
    stateResponse.arrayBuffer(),
  ]);
  const metroArchive = archiveFromBytes(metroBytes);
  const stateArchive = archiveFromBytes(stateBytes);
  const metroRows = parse(csvFromArchive(metroArchive, "MARPP"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  const stateRows = parse(csvFromArchive(stateArchive, "SARPP"), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  const numericYears = Object.keys(metroRows[0] ?? {}).filter((key) => /^\d{4}$/.test(key)).sort();
  const year = numericYears.at(-1);
  if (!year) throw new Error("BEA MARPP archive has no annual columns");
  const release = releaseFromArchive(metroArchive, "MARPP");
  if (!release || release.year !== year) throw new Error(`BEA release metadata does not match latest year ${year}`);

  const metros = {};
  for (const row of metroRows) {
    if (String(row.TableName).trim() !== "MARPP" || Number(row.LineCode) !== 1) continue;
    const geoFips = String(row.GeoFIPS).replace(/[^0-9]/g, "").padStart(5, "0");
    if (geoFips === "00000" || geoFips === "00999") continue;
    const name = String(row.GeoName)
      .replace(/\s*\*\s*$/, "")
      .replace(/\s*\(Metropolitan Statistical Area\)\s*$/i, "")
      .trim();
    const factor = asNumber(row[year]);
    const key = normalizeBeaArea(name);
    if (key && factor && factor >= 70 && factor <= 140) metros[key] = { name, geoFips, factor: round(factor / 100) };
  }

  const states = {};
  for (const row of stateRows) {
    if (String(row.TableName).trim() !== "SARPP" || Number(row.LineCode) !== 1) continue;
    const geoFips = String(row.GeoFIPS).replace(/[^0-9]/g, "").padStart(5, "0");
    const state = FIPS_STATE[geoFips.slice(0, 2)];
    const factor = asNumber(row[year]);
    if (state && factor && factor >= 70 && factor <= 140) states[state] = round(factor / 100);
  }
  return { year, releaseDate: release.releaseDate, states, metros };
}

const generatedAt = new Date().toISOString();
const previousModel = await readFile(new URL("../dist/model-data.json", import.meta.url), "utf8").then(JSON.parse).catch(() => null);
const [labor, geography, energy, certifiedProducts, regionalPriceParity] = await Promise.all([
  fetchBlsLabor(previousModel?.labor),
  fetchGeography(),
  fetchEia(),
  fetchCertifiedProducts(),
  fetchBeaRegionalPrices(),
]);

const fingerprintSource = JSON.stringify({ geography, labor, energy, certifiedProducts, regionalPriceParity });
const fingerprint = createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 12);
const model = {
  schemaVersion: 1,
  modelVersion: `qv-${generatedAt.slice(0, 10).replaceAll("-", ".")}-${fingerprint}`,
  generatedAt,
  updatePolicy: {
    schedule: "Every Tuesday at 09:17 UTC",
    behavior: "Automatic publish only after source, coverage, unit, bounds, and schema validation. Failure preserves the previous public snapshot.",
    aiUsed: false,
  },
  sources: [
    { id: "bls-oews", name: "BLS OEWS occupational wages", url: "https://www.bls.gov/oes/tables.htm", period: labor.release, checked: generatedAt, refresh: "annual" },
    { id: "eia-electricity", name: "EIA residential electricity prices", url: "https://www.eia.gov/electricity/data.php", period: Math.max(...Object.values(energy.states).map((row) => Number(String(row.electricityPeriod).replace("-", "")) || 0)).toString().replace(/^(\d{4})(\d{2})$/, "$1-$2"), checked: generatedAt, refresh: "monthly" },
    { id: "eia-natural-gas", name: "EIA residential natural-gas prices", url: "https://www.eia.gov/dnav/ng/ng_pri_sum_a_EPG0_PRS_DMcf_m.htm", period: Math.max(...Object.values(energy.states).map((row) => Number(String(row.naturalGasPeriod).replace("-", "")) || 0)).toString().replace(/^(\d{4})(\d{2})$/, "$1-$2"), checked: generatedAt, refresh: "monthly" },
    { id: "energy-star-gas-wh", name: "ENERGY STAR certified gas water heaters", url: "https://data.energystar.gov/resource/6sbi-yuk2", period: "live certified-product dataset", checked: generatedAt, refresh: "weekly" },
    { id: "energy-star-hpwh", name: "ENERGY STAR certified heat-pump water heaters", url: "https://data.energystar.gov/resource/v7jr-74b4", period: "live certified-product dataset", checked: generatedAt, refresh: "weekly" },
    { id: "zip-reference", name: "ReadyAPIs curated U.S. ZIP reference", url: "https://github.com/ReadyAPIs-com/curated-us-zips", period: "current main branch", checked: generatedAt, refresh: "weekly check" },
    { id: "bea-rpp", name: "BEA Regional Price Parities", url: "https://www.bea.gov/data/prices-inflation/regional-price-parities-state-and-metro-area", period: `${regionalPriceParity.year} · released ${regionalPriceParity.releaseDate}`, checked: generatedAt, refresh: "annual release, checked weekly" },
  ],
  geography,
  labor,
  energy,
  certifiedProducts,
  regionalPriceParity,
};

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/model-data.json", import.meta.url), `${JSON.stringify(model)}\n`);
console.log(`Generated ${model.modelVersion}: ${geography.zipCount} ZIPs, ${Object.keys(labor.stateFactors).length} labor regions, ${Object.keys(regionalPriceParity.metros).length} BEA metros.`);
