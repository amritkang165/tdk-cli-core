import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { BACKEND_FRAMEWORKS } from "../../backend-frameworks/registry.js";
import { BACKEND_LANGUAGES } from "../../backend-languages/registry.js";
import { FRONTEND_FRAMEWORKS } from "../../frontend-frameworks/registry.js";
import {
  CREATABLE_RESOURCE_TYPES,
  RESOURCE_CONFIG_APP_TYPES,
  type ResourceConfigFields,
} from "../../types/index.js";
import { RESOURCE_FEATURES } from "../../utils/resource-features.js";
import { validateServiceManifest } from "../../utils/service-manifest.js";
import { createByoServiceJson, createServiceJson } from "../resource.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const schema = JSON.parse(readFileSync(join(repoRoot, "schemas", "service.schema.json"), "utf-8"));
const publishWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "publish-service-schema.yml"),
  "utf-8",
);
const byoValidationScripts = [
  readFileSync(join(repoRoot, "tests", "e2e", "byo-python.test.sh"), "utf-8"),
  readFileSync(join(repoRoot, "tests", "e2e", "byo-python-boot.test.sh"), "utf-8"),
];

const frameworkIds = [...Object.keys(FRONTEND_FRAMEWORKS), ...Object.keys(BACKEND_FRAMEWORKS)];
const languageIds = Object.keys(BACKEND_LANGUAGES);
// NATS is an engine-supported manifest feature used by existing services but is not a CLI resource generator.
const supportedManifestFeatures = [...Object.keys(RESOURCE_FEATURES), "nats"];
const ajv = new Ajv2020({ allErrors: true });
const validateService = ajv.compile(schema);
const RESOURCE_CONFIG_FIELDS = [
  "appName",
  "appType",
  "stack",
  "schemaVersion",
  "port",
  "replicas",
  "runtime",
  "featuresEnabled",
  "dependsOn",
  "enabled",
  "basePath",
  "backendName",
  "apiPath",
  "healthCheckPath",
  "smoke",
  "traefik",
  "sablier",
  "dockerfile",
  "image",
] as const satisfies readonly (keyof ResourceConfigFields)[];
type ResourceConfigFieldsAreComplete =
  Exclude<keyof ResourceConfigFields, (typeof RESOURCE_CONFIG_FIELDS)[number]> extends never
    ? true
    : false;
const resourceConfigFieldsAreComplete: ResourceConfigFieldsAreComplete = true;

// The CLI provider registries are the contract: the CLI rejects an unknown id before it writes a resource. The JSON Schema is only
// an editor hint, so adding a provider must not require touching its open framework/language fields.
describe("service-schema.json stays independent of the provider registries", () => {
  it("tracks ResourceConfig fields, app types, and registered feature names", () => {
    expect(resourceConfigFieldsAreComplete).toBe(true);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([...RESOURCE_CONFIG_FIELDS]),
    );
    expect(schema.properties.appType.enum).toEqual(RESOURCE_CONFIG_APP_TYPES);
    expect(schema.properties.type.enum).toEqual(RESOURCE_CONFIG_APP_TYPES);
    expect(schema.properties.featuresEnabled.items.enum).toEqual(supportedManifestFeatures);
    const checkPropertyDescriptions = (objectSchema: { properties?: Record<string, unknown> }) => {
      for (const [name, property] of Object.entries(objectSchema.properties ?? {})) {
        expect(
          (property as { description?: string }).description,
          `${name} description`,
        ).toBeTruthy();
        checkPropertyDescriptions(property as { properties?: Record<string, unknown> });
      }
    };
    checkPropertyDescriptions(schema);
  });

  it("validates all service manifests created by the resource generators", () => {
    const generatedServices = [
      ...CREATABLE_RESOURCE_TYPES.map((type, index) =>
        type === "bring-your-own"
          ? createByoServiceJson("test-byo", "shop", 4500, {
              healthCheckPath: "/health",
              dockerfile: "Dockerfile",
            })
          : createServiceJson(`test-${type}`, type, "shop", 4000 + index),
      ),
      ...Object.keys(FRONTEND_FRAMEWORKS).map((framework, index) =>
        createServiceJson(
          `test-frontend-${framework}`,
          "frontend",
          "shop",
          3000 + index,
          [],
          framework,
        ),
      ),
      ...Object.keys(BACKEND_FRAMEWORKS).map((framework, index) =>
        createServiceJson(
          `test-backend-${framework}`,
          "backend",
          "shop",
          4000 + index,
          [],
          framework,
        ),
      ),
      ...Object.keys(BACKEND_LANGUAGES).map((language, index) =>
        createServiceJson(
          `test-backend-${language}`,
          "backend",
          "shop",
          4500 + index,
          [],
          undefined,
          language,
        ),
      ),
    ];

    for (const service of generatedServices) {
      expect(validateService(service), JSON.stringify(validateService.errors)).toBe(true);
    }
  });

  it("accepts the NATS feature used by existing service manifests", () => {
    expect(
      validateService({ appName: "orders-api", appType: "backend", featuresEnabled: ["nats"] }),
    ).toBe(true);
  });

  it("validates supported post-start smoke checks", () => {
    expect(
      validateService({
        appName: "orders-api",
        appType: "backend",
        smoke: {
          via: "proxy",
          steps: [{ name: "health", path: "/health", expect: 200 }],
        },
      }),
    ).toBe(true);
  });

  it("bounds ports to valid TCP port numbers", () => {
    for (const port of [1, 65535]) {
      expect(validateService({ appName: "api", appType: "backend", port })).toBe(true);
    }
    for (const port of [0, 65536, 1.5]) {
      expect(validateService({ appName: "api", appType: "backend", port })).toBe(false);
    }
  });

  it("accepts the legacy `type` alias when appType is absent", () => {
    expect(validateService({ appName: "legacy-api", type: "backend" })).toBe(true);
  });

  it("treats `$schema` as editor metadata during service-manifest discovery", () => {
    const result = validateServiceManifest(
      {
        $schema: schema.$id,
        appName: "api",
        appType: "backend",
        stack: "shop",
        schemaVersion: 1,
      },
      "service.json",
    );
    expect(result.warnings).toEqual([]);
  });

  it("validates BYO service manifests with the Draft 2020-12 validator", () => {
    for (const script of byoValidationScripts) {
      expect(script).toContain("scripts/validate-service-json.mjs");
    }
  });

  it("accepts every registered framework and language id with its open pattern", () => {
    const framework = new RegExp(schema.properties.framework.pattern);
    const language = new RegExp(schema.properties.language.pattern);
    for (const id of frameworkIds) expect(id, `framework ${id}`).toMatch(framework);
    for (const id of languageIds) expect(id, `language ${id}`).toMatch(language);
    expect(schema.properties.framework.enum).toBeUndefined();
    expect(schema.properties.language.enum).toBeUndefined();
  });

  it("keeps `examples` a short hint that names real providers, not a catalog to edit per provider", () => {
    for (const field of ["framework", "language"] as const) {
      const examples: string[] = schema.properties[field].examples;
      const registered = field === "framework" ? frameworkIds : languageIds;
      expect(
        examples.length,
        `${field} examples are a hint, not a list of every provider`,
      ).toBeLessThanOrEqual(3);
      for (const id of examples) expect(registered, `${field} example ${id}`).toContain(id);
    }
  });

  it("describes the ids as coming from the CLI registry", () => {
    expect(schema.properties.framework.description).toMatch(/registr(y|ies)/i);
    expect(schema.properties.language.description).toMatch(/registr(y|ies)/i);
  });
});

describe("publishing the schema from main", () => {
  it("only publishes after a change lands on main, never from a pull request", () => {
    expect(publishWorkflow).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(publishWorkflow).not.toContain("pull_request");
  });

  it("reports whether the live copy matches main, so a missing token is not a silent success", () => {
    expect(publishWorkflow).toContain("Report whether the published schema matches main");
    expect(publishWorkflow).toContain("https://tdk-landscape.github.io/schema.service.json");
    expect(publishWorkflow).toContain("GITHUB_STEP_SUMMARY");
  });
});
