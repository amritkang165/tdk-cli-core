import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

const [servicePath] = process.argv.slice(2);
if (!servicePath) {
  console.error("Usage: node scripts/validate-service-json.mjs <service.json>");
  process.exit(2);
}

const schemaPath = new URL("../schemas/service.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const service = JSON.parse(readFileSync(resolve(servicePath), "utf8"));
const validate = new Ajv2020({ allErrors: true }).compile(schema);

if (!validate(service)) {
  for (const error of validate.errors ?? []) {
    console.error(`${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
  }
  process.exit(1);
}

console.log(`${servicePath} is valid.`);
