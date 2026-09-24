import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

import {CONTRACT_VERSION} from "./contracts/constants.ts";
import {validateHostProfile, validateSkinManifest} from "./contracts/validation.ts";
import type {HostProfile, ValidationIssue} from "./contracts/models.ts";

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

interface Report {
  contract: string;
  command: string;
  target: string;
  valid: boolean;
  issues?: ValidationIssue[];
  error?: string;
}

const USAGE = `dsh-skin - DSH EAC UI skin package conformance checker (${CONTRACT_VERSION})

Usage:
  dsh-skin check <manifest.json> [...more] [--profile <host-profile.json>]
  dsh-skin version
  dsh-skin help

Options:
  --profile <path>  validate every contribution against the active host
                    profile: slot ids, slot kind/scope, and capability ranges
  -h, --help        show this help
  -v, --version     print the contract and package versions

Exit codes: 0 valid, 1 a manifest failed validation, 2 the command was wrong.
Output is one JSON object per target on stdout so release CI can consume it.`;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function report(command: string, target: string, issues: ValidationIssue[]): Report {
  return {contract: CONTRACT_VERSION, command, target, valid: issues.length === 0, issues};
}

export async function runCommand(argv: string[], io: CliIo = {stdout: (line) => console.log(line), stderr: (line) => console.error(line)}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "-h" || command === "--help") {
    io.stdout(USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  if (command === "version" || command === "-v" || command === "--version") {
    io.stdout(JSON.stringify({contract: CONTRACT_VERSION, version: await packageVersion()}));
    return EXIT_OK;
  }
  if (command === "check") return runCheck(rest, io);
  io.stderr(JSON.stringify({contract: CONTRACT_VERSION, command, valid: false, error: `unknown command ${command}` }));
  io.stderr(USAGE);
  return EXIT_USAGE;
}

async function runCheck(args: string[], io: CliIo): Promise<number> {
  const targets: string[] = [];
  let profilePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--profile") {
      profilePath = args[index + 1];
      index += 1;
      if (profilePath === undefined) {
        io.stderr(JSON.stringify({contract: CONTRACT_VERSION, command: "check", valid: false, error: "--profile requires a path"}));
        return EXIT_USAGE;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      io.stderr(JSON.stringify({contract: CONTRACT_VERSION, command: "check", valid: false, error: `unknown option ${arg}`}));
      return EXIT_USAGE;
    }
    targets.push(arg);
  }
  if (targets.length === 0) {
    io.stderr(JSON.stringify({contract: CONTRACT_VERSION, command: "check", valid: false, error: "at least one manifest path is required"}));
    return EXIT_USAGE;
  }
  let profile: HostProfile | undefined;
  if (profilePath !== undefined) {
    try {
      const candidate = await readJson(profilePath);
      const validation = validateHostProfile(candidate);
      if (!validation.ok) {
        io.stdout(JSON.stringify(report("check", resolve(profilePath), validation.issues)));
        return EXIT_INVALID;
      }
      profile = validation.value!;
    } catch (error) {
      io.stderr(JSON.stringify({contract: CONTRACT_VERSION, command: "check", target: resolve(profilePath), valid: false, error: describe(error)}));
      return EXIT_USAGE;
    }
  }
  let worst = EXIT_OK;
  for (const target of targets) {
    try {
      const manifest = await readJson(target);
      const validation = validateSkinManifest(manifest, profile === undefined ? {} : {profile});
      const issues = validation.ok ? [] : validation.issues;
      io.stdout(JSON.stringify(report("check", resolve(target), issues)));
      if (!validation.ok) worst = EXIT_INVALID;
    } catch (error) {
      io.stdout(JSON.stringify({contract: CONTRACT_VERSION, command: "check", target: resolve(target), valid: false, error: describe(error)} satisfies Report));
      worst = EXIT_INVALID;
    }
  }
  return worst;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {version?: unknown};
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}
