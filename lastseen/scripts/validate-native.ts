// Validate the JSON a native plugin produces against the contract (docs/NATIVE_CONTRACT.md).
//   pnpm validate:native list                                        every plugin/target pair
//   pnpm validate:native example detector placementCandidate         print a valid sample payload
//   pnpm validate:native detector placementCandidate payload.json    validate a captured payload (file, or - for stdin)
//   pnpm validate:native --examples                                  self-check: every built-in example is valid
import { readFileSync } from "node:fs";
import { NATIVE_EXAMPLES, NATIVE_SCHEMAS } from "../packages/shared/src/index";
import type { NativePlugin } from "../packages/shared/src/index";

const [a, b, c] = process.argv.slice(2);

interface Validator {
  safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}
const schemas = NATIVE_SCHEMAS as unknown as Record<string, Record<string, Validator>>;

const usage = (): never => {
  console.error("usage: validate:native <list | example <plugin> <target> | <plugin> <target> <file|-> | --examples>");
  return process.exit(2);
};

function report(plugin: string, target: string, value: unknown): boolean {
  const schema = schemas[plugin]?.[target];
  if (!schema) {
    console.error(`unknown ${plugin}/${target}. Try: pnpm validate:native list`);
    return false;
  }
  const r = schema.safeParse(value);
  if (r.success) {
    console.log(`OK   ${plugin}.${target}`);
    return true;
  }
  console.log(`FAIL ${plugin}.${target}`);
  for (const i of r.error?.issues ?? []) console.log(`  - ${i.path.map(String).join(".") || "(root)"}: ${i.message}`);
  return false;
}

if (a === "list") {
  for (const [p, t] of Object.entries(schemas)) console.log(`${p}: ${Object.keys(t).join(", ")}`);
} else if (a === "--examples") {
  let ok = true;
  for (const [p, targets] of Object.entries(NATIVE_EXAMPLES)) for (const [t, v] of Object.entries(targets)) ok = report(p, t, v) && ok;
  process.exit(ok ? 0 : 1);
} else if (a === "example" && b && c) {
  const ex = NATIVE_EXAMPLES[b as NativePlugin]?.[c];
  if (ex === undefined) usage();
  console.log(JSON.stringify(ex, null, 2));
} else if (a && b && c) {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(c === "-" ? 0 : c, "utf8"));
  } catch (e) {
    console.error(`cannot read JSON from ${c}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  process.exit(report(a, b, value) ? 0 : 1);
} else {
  usage();
}
