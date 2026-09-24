import assert from "node:assert/strict";
import {mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import test from "node:test";

import {
  InstallError,
  PackageInstaller,
  loadArtifact,
  sha256Hex,
  verifyInventory,
  writeZip,
  ArtifactError,
  type LoadedArtifact
} from "../src/index.ts";
import type {SkinManifest} from "../src/index.ts";

const ENTRY = "export const mount = () => {};\n";
const STYLE = ".session { color: rebeccapurple }\n";

function manifestOf(files: Array<{path: string; data: string}>): SkinManifest {
  const assets = files.map((file) => ({path: file.path, sha256: sha256Hex(new TextEncoder().encode(file.data))}));
  return {
    apiVersion: "dsh.eac.ui-skin/v1",
    kind: "SkinPackage",
    metadata: {id: "third.party.skin", version: "1.0.0", name: "Third party", author: "publisher"},
    engines: {manager: "^1.0.0", hostProfile: "^0.3.0"},
    dependencies: [],
    contributions: [{
      id: "session.main", slot: "session", entry: "regions/session/entry.js", assets: ["regions/session/entry.js"],
      style: {entry: "regions/session/styles.css", assets: ["regions/session/styles.css"]},
      requires: {capabilities: [], slotKind: ["region"], slotScope: ["window"]},
      lifecycle: {mount: "mount", health: "health", unmount: "unmount"}
    }],
    assets,
    integrity: Object.fromEntries(assets.map((asset) => [asset.path, asset.sha256]))
  };
}

const DEFAULT_FILES = [{path: "regions/session/entry.js", data: ENTRY}, {path: "regions/session/styles.css", data: STYLE}];
const DEFAULT_MANIFEST = manifestOf(DEFAULT_FILES);

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "skin-install-"));
}

async function stage(source: string, files: Array<{path: string; data: string}>, manifest: SkinManifest = DEFAULT_MANIFEST): Promise<string> {
  const root = join(source, "artifact");
  for (const file of files) {
    const absolute = join(root, ...file.path.split("/"));
    await mkdir(dirname(absolute), {recursive: true});
    await writeFile(absolute, file.data, "utf8");
  }
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return root;
}

const code = (run: () => Promise<unknown>): Promise<string> => run().then(
  () => assert.fail("expected the import to be refused"),
  (error: unknown) => {
    assert.ok(error instanceof InstallError || error instanceof ArtifactError, `expected an Install/ArtifactError, got ${String(error)}`);
    return error.code;
  }
);

test("a directory artifact installs content-addressed and byte-identical payload files", async () => {
  const base = await workspace();
  const source = await stage(base, DEFAULT_FILES);
  const artifact = await loadArtifact(source);
  assert.equal(artifact.kind, "directory");
  assert.equal(artifact.archiveDigest, undefined);

  const installer = new PackageInstaller(join(base, "store"));
  const result = await installer.import(artifact);
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.verifiedFiles, 2);
  assert.match(result.installed.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(join(base, "store", "packages", "third.party.skin", "1.0.0")), [result.installed.digest.slice(7)]);
  assert.equal(await readFile(join(result.installed.versionPath, "regions/session/entry.js"), "utf8"), ENTRY);
  assert.equal(await readFile(join(result.installed.versionPath, "regions/session/styles.css"), "utf8"), STYLE);
  assert.deepEqual(JSON.parse(await readFile(join(result.installed.versionPath, "manifest.json"), "utf8")), DEFAULT_MANIFEST);
});

test("re-importing the same bytes is idempotent and creates no second copy", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));
  const artifact = await loadArtifact(await stage(base, DEFAULT_FILES));
  const first = await installer.import(artifact);
  const second = await installer.import(artifact);
  assert.equal(second.alreadyInstalled, true);
  assert.equal(second.installed.digest, first.installed.digest);
  assert.equal(second.installed.versionPath, first.installed.versionPath);
});

test("changed payload bytes land in a different address", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));
  const before = await installer.import(await loadArtifact(await stage(base, DEFAULT_FILES)));
  const changed = [{path: "regions/session/entry.js", data: `${ENTRY}// patched\n`}, ...DEFAULT_FILES.slice(1)];
  const after = await installer.import(await loadArtifact(await stage(join(base, "second"), changed, manifestOf(changed))));
  assert.notEqual(after.installed.digest, before.installed.digest);
});

test("an undeclared, missing, or tampered payload file blocks the install", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));

  const extra = await stage(base, [...DEFAULT_FILES, {path: "regions/session/secret.js", data: "steal()"}]);
  const undeclared = await loadArtifact(extra);
  assert.equal(await code(() => installer.import(undeclared)), "INTEGRITY_MISMATCH");
  assert.deepEqual((await readdir(join(base, "store", "packages")).catch(() => [])), [], "nothing may be published after a failed gate");

  const missing = await stage(join(base, "m"), DEFAULT_FILES.slice(1), DEFAULT_MANIFEST);
  const missingArtifact = await loadArtifact(missing);
  assert.equal(await code(() => installer.import(missingArtifact)), "INTEGRITY_MISMATCH");

  const tampered = await stage(join(base, "t"), [{path: "regions/session/entry.js", data: "evil()\n"}, DEFAULT_FILES[1]!]);
  const tamperedArtifact = await loadArtifact(tampered);
  assert.equal(await code(() => installer.import(tamperedArtifact)), "INTEGRITY_MISMATCH");
});

test("a locked digest from the catalog or build lock is enforced", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));
  const artifact = await loadArtifact(await stage(base, DEFAULT_FILES));
  assert.equal(await code(() => installer.import(artifact, {expectedDigest: `sha256:${"f".repeat(64)}`})), "INTEGRITY_DIGEST_MISMATCH");
  assert.equal(await code(() => installer.import(artifact, {expectedDigest: "not-a-digest"})), "INTEGRITY_DIGEST_INVALID");
  assert.deepEqual((await readdir(join(base, "store")).catch(() => [])), [], "a digest mismatch must not create the store");
  const {installed} = await installer.import(artifact);
  const again = await installer.import(artifact, {expectedDigest: installed.digest});
  assert.equal(again.installed.digest, installed.digest);
});

test("an install root that is not absolute is refused before any write", () => {
  assert.throws(() => new PackageInstaller("relative/store"), /PATH_ABSOLUTE_REQUIRED/);
});

test("a zip artifact keeps its whole-archive digest for external provenance", async () => {
  const base = await workspace();
  const files = [...DEFAULT_FILES.map((file) => ({name: file.path, data: new TextEncoder().encode(file.data)})), {name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(DEFAULT_MANIFEST))}];
  const archivePath = join(base, "third.party.skin-1.0.0.zip");
  const bytes = writeZip(files);
  await writeFile(archivePath, bytes);
  const artifact = await loadArtifact(archivePath);
  assert.equal(artifact.kind, "zip");
  assert.equal(artifact.archiveDigest, `sha256:${sha256Hex(bytes)}`);
  const installer = new PackageInstaller(join(base, "store"));
  const result = await installer.import(artifact);
  assert.equal(result.verifiedFiles, 2);
  assert.equal(result.installed.archiveDigest, artifact.archiveDigest);
  assert.equal(await readFile(join(result.installed.versionPath, "regions/session/styles.css"), "utf8"), STYLE);
});

test("an official .dshpack wraps exactly one declared skin payload", async () => {
  const base = await workspace();
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const pack = {id: "dsh.eac.official", version: "3.1.0", contents: [{type: "ui-skin", path: "skins/default/"}, {type: "skill", path: "skills/other/"}]};
  const bytes = writeZip([
    {name: "pack.json", data: encode(pack)},
    {name: "skins/default/manifest.json", data: encode(DEFAULT_MANIFEST)},
    {name: "skins/default/regions/session/entry.js", data: new TextEncoder().encode(ENTRY)},
    {name: "skins/default/regions/session/styles.css", data: new TextEncoder().encode(STYLE)},
    {name: "skills/other/skill.md", data: encode("ignored")}
  ]);
  const path = join(base, "official.dshpack");
  await writeFile(path, bytes);
  const artifact = await loadArtifact(path);
  assert.equal(artifact.kind, "dshpack");
  assert.deepEqual(artifact.files.map((file) => file.name), ["manifest.json", "regions/session/entry.js", "regions/session/styles.css"], "the payload root is stripped");
  assert.deepEqual(artifact.container, {id: "dsh.eac.official", version: "3.1.0", root: "skins/default/"});

  const installer = new PackageInstaller(join(base, "store"));
  const result = await installer.import(artifact);
  assert.equal(result.installed.container?.root, "skins/default/");
  assert.notEqual(result.installed.archiveDigest, undefined, "the outer archive digest stays external provenance");
});

test("a generic feature pack is not accepted as a skin", async () => {
  const base = await workspace();
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  const bytes = writeZip([{name: "pack.json", data: encode({id: "dsh.plugins", version: "1.0.0", contents: [{type: "plugin", path: "plugins/a/"}]})}]);
  const path = join(base, "generic.dshpack");
  await writeFile(path, bytes);
  assert.equal(await code(() => loadArtifact(path)), "COMPATIBILITY_DSHPACK_NO_SKIN");

  const twoSkins = writeZip([
    {name: "pack.json", data: encode({id: "dsh.two", version: "1.0.0", contents: [{type: "ui-skin", path: "a/"}, {type: "ui-skin", path: "b/"}]})},
    {name: "a/manifest.json", data: encode(DEFAULT_MANIFEST)},
    {name: "b/manifest.json", data: encode(DEFAULT_MANIFEST)}
  ]);
  const twoPath = join(base, "two.dshpack");
  await writeFile(twoPath, twoSkins);
  assert.equal(await code(() => loadArtifact(twoPath)), "COMPATIBILITY_DSHPACK_MULTIPLE_SKINS");

  const emptyRoot = writeZip([
    {name: "pack.json", data: encode({id: "dsh.empty", version: "1.0.0", contents: [{type: "ui-skin", path: "missing/"}]})},
    {name: "other/file.js", data: encode("x")}
  ]);
  const emptyPath = join(base, "empty.dshpack");
  await writeFile(emptyPath, emptyRoot);
  assert.equal(await code(() => loadArtifact(emptyPath)), "COMPATIBILITY_DSHPACK_PAYLOAD_EMPTY");
});

test("a file that is not an archive or a directory is refused by name", async () => {
  const base = await workspace();
  const path = join(base, "notes.txt");
  await writeFile(path, "just a text file", "utf8");
  assert.equal(await code(() => loadArtifact(path)), "ARTIFACT_FORMAT_UNSUPPORTED");
});

test("a symlinked package member is never installed", async (t) => {
  const base = await workspace();
  const source = await stage(base, DEFAULT_FILES);
  const outside = join(base, "outside-secret.txt");
  await writeFile(outside, "secret", "utf8");
  try {
    await symlink(outside, join(source, "regions/session/link.js"));
  } catch {
    t.skip("the platform refuses unprivileged symlink creation");
    return;
  }
  assert.equal(await code(() => loadArtifact(source)), "PATH_SYMLINK");
});

test("two members differing only by case are refused before they can overwrite each other", async () => {
  const base = await workspace();
  // A case-distinct pair cannot be staged as a directory on NTFS, which would fold them into one file during
  // fixture creation, so the archive is built with both names intact.
  const collision = [
    {path: "regions/session/entry.js", data: ENTRY},
    {path: "regions/session/Entry.js", data: "different\n"},
    {path: "regions/session/styles.css", data: STYLE}
  ];
  const files = [...collision.map((file) => ({name: file.path, data: new TextEncoder().encode(file.data)})), {name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifestOf(collision)))}];
  const path = join(base, "collision.zip");
  await writeFile(path, writeZip(files));
  const artifact = await loadArtifact(path);
  assert.equal(artifact.files.length, 4, "the archive carries the manifest plus three members");
  assert.equal(await code(() => new PackageInstaller(join(base, "store")).import(artifact)), "PATH_DUPLICATE_CASE_INSENSITIVE");
});

test("an artifact without a parseable manifest is refused with the manifest codes", async () => {
  const base = await workspace();
  const root = join(base, "no-manifest");
  await mkdir(root, {recursive: true});
  await writeFile(join(root, "orphan.css"), "a{}", "utf8");
  assert.equal(await code(() => loadArtifact(root)), "MANIFEST_NOT_FOUND");

  const broken = await stage(base, DEFAULT_FILES, {kind: "SkinPackage"} as unknown as SkinManifest);
  assert.equal(await code(() => loadArtifact(broken)), "MANIFEST_INVALID");
});

test("inventory verdicts are independent of member order", () => {
  const files = DEFAULT_FILES.map((file) => ({name: file.path, data: new TextEncoder().encode(file.data)}));
  assert.equal(verifyInventory(DEFAULT_MANIFEST, files).ok, true);
  assert.equal(verifyInventory(DEFAULT_MANIFEST, [...files].reverse()).ok, true);
  const wrong = verifyInventory(DEFAULT_MANIFEST, [{name: "regions/session/entry.js", data: new TextEncoder().encode("nope")}]);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.issues.some((issue) => issue.code === "INTEGRITY_MISMATCH"));
  assert.ok(wrong.issues.some((issue) => issue.code === "INTEGRITY_MISSING"));
});

test("the envelope metadata files may not be declared as payload assets", () => {
  const files = [{name: "LICENSE", data: new TextEncoder().encode("MIT")}];
  const declaring = manifestOf([...DEFAULT_FILES, {path: "LICENSE", data: "MIT"}]);
  assert.ok(verifyInventory(declaring, [...DEFAULT_FILES.map((file) => ({name: file.path, data: new TextEncoder().encode(file.data)})), ...files]).issues.some((issue) => issue.code === "ASSET_ENVELOPE_RESERVED"));
  const carrying = manifestOf(DEFAULT_FILES);
  assert.equal(verifyInventory(carrying, [...DEFAULT_FILES.map((file) => ({name: file.path, data: new TextEncoder().encode(file.data)})), ...files]).ok, true, "an undeclared LICENSE is legitimate envelope content");
});

test("uninstall removes exactly the digest directory it is given", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));
  const artifact = await loadArtifact(await stage(base, DEFAULT_FILES));
  const {installed} = await installer.import(artifact);
  assert.equal(await installer.remove("third.party.skin", "1.0.0", installed.digest), true);
  assert.deepEqual(await readdir(join(base, "store", "packages", "third.party.skin", "1.0.0")).catch(() => []), []);
  assert.equal(await installer.remove("third.party.skin", "1.0.0", installed.digest), false);
  await assert.rejects(() => installer.remove("third.party.skin", "1.0.0", "sha256:zz"), /INTEGRITY_DIGEST_INVALID/);
});

test("content addressing is reproducible across stores and re-installs", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));
  const artifact: LoadedArtifact = await loadArtifact(await stage(base, DEFAULT_FILES));
  const first = await installer.import(artifact);
  const reused = await installer.import(artifact);
  assert.equal(reused.alreadyInstalled, true, "an existing address is reused rather than re-staged");
  await rm(join(base, "store"), {recursive: true, force: true});
  const fromScratch = await new PackageInstaller(join(base, "other-store")).import(artifact);
  assert.equal(fromScratch.installed.digest, first.installed.digest);
  assert.ok(fromScratch.installed.versionPath.endsWith(first.installed.digest.slice(7)));
  const leftovers = await readdir(join(base, "store", "packages", "third.party.skin", "1.0.0")).catch(() => []);
  assert.deepEqual(leftovers, [], "a failed or reused import leaves no .staging directory behind");
});

test("a store coordinate is proven path-safe before it is turned into a path", async () => {
  const base = await workspace();
  const installer = new PackageInstaller(join(base, "store"));
  const digest = `sha256:${"a".repeat(64)}`;
  const victim = join(base, "victim", "1.0.0", digest.slice(7));
  await mkdir(victim, {recursive: true});
  await writeFile(join(victim, "precious.txt"), "keep me", "utf8");

  assert.equal(await code(() => installer.remove("../../victim", "1.0.0", digest)), "MANIFEST_ID");
  assert.equal(await code(() => installer.remove("victim", "v1.0.0", digest)), "MANIFEST_VERSION");
  assert.equal(await code(() => installer.remove("victim", "1.0.0", "sha256:zz")), "INTEGRITY_DIGEST_INVALID");
  assert.throws(() => installer.versionPath("a/b", "1.0.0", digest), /MANIFEST_ID/);
  assert.equal(await readFile(join(victim, "precious.txt"), "utf8"), "keep me", "a refused coordinate may not delete anything");
});

test("a reused installation is re-verified against the digest that names it", async () => {
  const base = await workspace();
  const artifact = await loadArtifact(await stage(base, DEFAULT_FILES));
  const installer = new PackageInstaller(join(base, "store"));
  const first = await installer.import(artifact);
  assert.equal((await installer.import(artifact)).alreadyInstalled, true, "an intact tree is still reused");

  const entry = join(first.installed.versionPath, "regions/session/entry.js");
  await writeFile(entry, "export const mount = () => steal();\n", "utf8");
  assert.equal(await code(() => installer.import(artifact)), "INTEGRITY_MISMATCH", "bytes edited after publish must not keep loading");
  await writeFile(entry, DEFAULT_FILES[0]!.data, "utf8");
  await rm(join(first.installed.versionPath, "manifest.json"), {force: true});
  assert.equal(await code(() => installer.import(artifact)), "INTEGRITY_MISMATCH", "a stripped manifest is not an intact installation");
});
