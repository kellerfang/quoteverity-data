import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import * as XLSX from "xlsx";

const URLS = {
  blsState: "https://www.bls.gov/oes/special-requests/oesm25st.zip",
  blsNational: "https://www.bls.gov/oes/special-requests/oesm25nat.zip",
  eiaElectricity: "https://api.eia.gov/v2/electricity/retail-sales/data/",
  eiaGas: "https://api.eia.gov/v2/natural-gas/pri/sum/data/",
  energyStarGas: "https://data.energystar.gov/resource/6sbi-yuk2.json?$limit=50000",
  energyStarHeatPump: "https://data.energystar.gov/resource/v7jr-74b4.json?$limit=50000",
  zipCsv: "https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv",
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

async function readBlsWorkbook(url) {
  const response = await fetchChecked(url);
  const archive = new AdmZip(Buffer.from(await response.arrayBuffer()));
  const entry = archive.getEntries().find((candidate) => /\.xlsx$/i.test(candidate.entryName));
  if (!entry) throw new Error(`No XLSX file found in ${url}`);
  const workbook = XLSX.read(entry.getData(), { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: true });
}

function findOccupation(rows, code, state) {
  const row = rows.find((candidate) => String(candidate.OCC_CODE ?? candidate.occ_code) === code && (!state || String(candidate.PRIM_STATE ?? candidate.prim_state) === state));
  return row ? asNumber(row.H_MEDIAN ?? row.h_median) : null;
}

function buildLabor(stateRows, nationalRows) {
  const nationalHourlyMedian = Object.fromEntries(Object.entries(TRADES).map(([trade, code]) => {
    const wage = findOccupation(nationalRows, code);
    if (!wage || wage < 10 || wage > 100) throw new Error(`Missing national BLS median for ${trade} (${code})`);
    return [trade, round(wage, 2)];
  }));

  const stateFactors = {};
  for (const state of STATE_CODES) {
    const tradeFactors = {};
    for (const [trade, code] of Object.entries(TRADES)) {
      const wage = findOccupation(stateRows, code, state) ?? nationalHourlyMedian[trade];
      tradeFactors[trade] = round(clamp(wage / nationalHourlyMedian[trade], 0.6, 1.7));
    }
    stateFactors[state] = tradeFactors;
  }
  return { release: "May 2025", nationalHourlyMedian, stateFactors };
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

const generatedAt = new Date().toISOString();
const [stateRows, nationalRows, geography, energy, certifiedProducts] = await Promise.all([
  readBlsWorkbook(URLS.blsState),
  readBlsWorkbook(URLS.blsNational),
  fetchGeography(),
  fetchEia(),
  fetchCertifiedProducts(),
]);

const labor = buildLabor(stateRows, nationalRows);
const fingerprintSource = JSON.stringify({ geography, labor, energy, certifiedProducts });
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
  ],
  geography,
  labor,
  energy,
  certifiedProducts,
};

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/model-data.json", import.meta.url), `${JSON.stringify(model)}\n`);
console.log(`Generated ${model.modelVersion}: ${geography.zipCount} ZIPs, ${Object.keys(labor.stateFactors).length} labor regions.`);
