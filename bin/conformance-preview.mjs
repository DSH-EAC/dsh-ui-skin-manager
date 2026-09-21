#!/usr/bin/env node
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error("Usage: dsh-ui-skin-conformance-preview <manifest.json>");
  process.exitCode = 2;
} else {
  const {validateSkinManifest} = await import("../src/index.ts");
  try {
    const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
    const validation = validateSkinManifest(manifest);
    if (validation.ok) {
      console.log(JSON.stringify({contract: "dsh-ui-skin-manager@1", valid: true, manifest: resolve(manifestPath)}, null, 2));
    } else {
      console.error(JSON.stringify({contract: "dsh-ui-skin-manager@1", valid: false, manifest: resolve(manifestPath), issues: validation.issues}, null, 2));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({contract: "dsh-ui-skin-manager@1", valid: false, manifest: resolve(manifestPath), error: error instanceof Error ? error.message : String(error)}, null, 2));
    process.exitCode = 1;
  }
}
