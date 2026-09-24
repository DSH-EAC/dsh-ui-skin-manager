import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {EXIT_INVALID, EXIT_OK, EXIT_USAGE, runCommand} from "../src/cli.ts";

function capture(): {out: string[]; err: string[]; io: {stdout(line: string): void; stderr(line: string): void}} {
  const out: string[] = [];
  const err: string[] = [];
  return {out, err, io: {stdout: (line) => { out.push(line); }, stderr: (line) => { err.push(line); }}};
}
const json = (lines: string[]): Record<string, any>[] => lines.map((line) => JSON.parse(line) as Record<string, any>);
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("check reports a machine-readable verdict for a valid manifest", async () => {
  const sink = capture();
  const code = await runCommand(["check", fixture("valid/minimal-skin.json")], sink.io);
  assert.equal(code, EXIT_OK);
  const [report] = json(sink.out);
  assert.equal(report?.valid, true);
  assert.equal(report?.contract, "dsh-ui-skin-manager@1");
  assert.deepEqual(report?.issues, []);
});

test("check exits non-zero and names every violation for an invalid manifest", async () => {
  const sink = capture();
  const code = await runCommand(["check", fixture("invalid/path-traversal.json")], sink.io);
  assert.equal(code, EXIT_INVALID);
  assert.ok(json(sink.out)[0]?.issues.some((issue: {code: string}) => issue.code === "PATH_UNSAFE"));
});

test("check applies the host profile gate only when one is supplied", async () => {
  const sink = capture();
  await runCommand(["check", fixture("valid/minimal-skin.json")], sink.io);
  assert.equal(json(sink.out)[0]?.valid, true);
  const withProfile = capture();
  const code = await runCommand(["check", fixture("valid/minimal-skin.json"), "--profile", fixture("valid/host-profile.json")], withProfile.io);
  assert.equal(code, EXIT_OK);
  assert.equal(json(withProfile.out)[0]?.valid, true);
  const mismatch = capture();
  assert.equal(await runCommand(["check", fixture("incompatible/host-profile.json"), "--profile", fixture("valid/host-profile.json")], mismatch.io), EXIT_INVALID);
  assert.ok(json(mismatch.out)[0]?.issues.some((issue: {code: string}) => issue.code === "COMPATIBILITY_HOST_PROFILE"));
});

test("check keeps going across targets and reports each one", async () => {
  const sink = capture();
  const code = await runCommand(["check", fixture("valid/minimal-skin.json"), fixture("invalid/path-traversal.json")], sink.io);
  assert.equal(code, EXIT_INVALID);
  assert.deepEqual(json(sink.out).map((report) => report.valid), [true, false]);
});

test("an unreadable target is reported as an invalid target, not a crash", async () => {
  const sink = capture();
  const code = await runCommand(["check", "does-not-exist.json"], sink.io);
  assert.equal(code, EXIT_INVALID);
  assert.match(String(json(sink.out)[0]?.error), /ENOENT/);
});

test("usage and version are explicit exit codes", async () => {
  const help = capture();
  assert.equal(await runCommand([], help.io), EXIT_USAGE);
  assert.match(help.err.join("\n") + help.out.join("\n"), /Usage:/);
  const version = capture();
  assert.equal(await runCommand(["version"], version.io), EXIT_OK);
  assert.equal(json(version.out)[0]?.contract, "dsh-ui-skin-manager@1");
  const unknown = capture();
  assert.equal(await runCommand(["frobnicate"], unknown.io), EXIT_USAGE);
  assert.match(unknown.err.join("\n"), /unknown command frobnicate/);
  const dangling = capture();
  assert.equal(await runCommand(["check", "x.json", "--profile"], dangling.io), EXIT_USAGE);
  assert.match(dangling.err.join("\n"), /--profile requires a path/);
});
