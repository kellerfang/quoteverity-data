import { readFile } from "node:fs/promises";

const model = JSON.parse(await readFile(new URL("../dist/model-data.json", import.meta.url), "utf8"));

function invariant(value, message) {
  if (!value) throw new Error(message);
}

invariant(model.schemaVersion === 1, "unsupported schema version");
invariant(Number.isFinite(Date.parse(model.generatedAt)), "invalid generatedAt");
invariant(model.geography.zipCount >= 33000, `ZIP coverage too small: ${model.geography.zipCount}`);
invariant(Object.keys(model.geography.stateByZip).length === model.geography.zipCount, "ZIP map count mismatch");
invariant(Object.keys(model.labor.stateFactors).length >= 51, "state labor coverage is incomplete");
invariant(Object.keys(model.energy.states).length >= 51, "state energy coverage is incomplete");

for (const [state, row] of Object.entries(model.labor.stateFactors)) {
  for (const [trade, factor] of Object.entries(row)) {
    invariant(Number.isFinite(factor) && factor >= 0.6 && factor <= 1.7, `${state} ${trade} labor factor out of range: ${factor}`);
  }
}

for (const [state, row] of Object.entries(model.energy.states)) {
  invariant(Number.isFinite(row.electricityCentsPerKwh) && row.electricityCentsPerKwh >= 5 && row.electricityCentsPerKwh <= 55, `${state} electricity rate invalid`);
  invariant(Number.isFinite(row.naturalGasDollarsPerMcf) && row.naturalGasDollarsPerMcf >= 2 && row.naturalGasDollarsPerMcf <= 80, `${state} natural gas rate invalid`);
}

invariant(model.certifiedProducts.heatPumpWaterHeaters.count >= 100, "ENERGY STAR heat-pump water-heater count too small");
invariant(model.certifiedProducts.gasWaterHeaters.count >= 100, "ENERGY STAR gas water-heater count too small");
invariant(model.sources.every((source) => source.url.startsWith("https://")), "non-HTTPS source URL");

console.log(`Validated QuoteVerity model ${model.modelVersion}: ${model.geography.zipCount} ZIPs, ${Object.keys(model.labor.stateFactors).length} labor regions, ${Object.keys(model.energy.states).length} energy regions.`);
