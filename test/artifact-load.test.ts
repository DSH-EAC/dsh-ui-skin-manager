import assert from "node:assert/strict";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {ARCHIVE_LIMITS, ArtifactError, loadArtifact} from "../src/index.ts";

const code = (run: Promise<unknown>): Promise<string> => run.then(
  () => assert.fail("expected the artifact to be refused"),
  (error: unknown) => {
    assert.ok(error instanceof ArtifactError, `expected an ArtifactError, got ${String(error)}`);
    return error.code;
  }
);

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skin-artifact-"));
}

test("an oversized archive is refused on the size the directory entry reports, not after it is read", async () => {
  const base = await workspace();
  const path = join(base, "huge.zip");
  // Not a zip at all, so the only way this can be refused for size is the pre-read check: parsing it would
  // have reported an unsupported format instead, which is what happens to a host that got there first.
  await writeFile(path, "x".repeat(4096), "utf8");
  assert.equal(await code(loadArtifact(path, {archiveBytes: 1024})), "ARTIFACT_TOO_LARGE");
  assert.equal(await code(loadArtifact(path, {archiveBytes: 8192})), "ARTIFACT_FORMAT_UNSUPPORTED", "a file inside the budget still reaches the format check");
});

test("a directory artifact is bounded per member, in total, and by member count", async () => {
  const base = await workspace();
  const root = join(base, "skin");
  await mkdir(join(root, "regions", "session"), {recursive: true});
  await writeFile(join(root, "manifest.json"), "{}\n", "utf8");
  await writeFile(join(root, "regions", "session", "entry.js"), "x".repeat(64), "utf8");

  assert.equal(await code(loadArtifact(root, {fileBytes: 16})), "ARTIFACT_TOO_LARGE", "one member over the per-file budget is refused");
  assert.equal(await code(loadArtifact(root, {fileBytes: 128, totalBytes: 16})), "ARTIFACT_TOO_LARGE", "members that fit alone may not fit together");
  assert.equal(await code(loadArtifact(root, {entries: 1})), "ARTIFACT_TOO_LARGE", "a walk that keeps descending has to stop somewhere");
  assert.equal(await code(loadArtifact(root, {entries: 99})), "MANIFEST_INVALID", "under the budgets the walk finishes and the manifest is what is checked next");
});

test("the shipped budgets are the ones the ZIP parser enforces", () => {
  assert.equal(ARCHIVE_LIMITS.archiveBytes, 512 * 1024 * 1024);
  assert.equal(ARCHIVE_LIMITS.fileBytes, 256 * 1024 * 1024);
  assert.equal(ARCHIVE_LIMITS.totalBytes, ARCHIVE_LIMITS.fileBytes, "an inflated payload gets the same ceiling however it arrived");
  assert.equal(ARCHIVE_LIMITS.entries, 0xffff, "a contract-v1 central directory cannot name more members than this");
});
