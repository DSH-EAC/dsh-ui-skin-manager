#!/usr/bin/env node
import {runCommand} from "../dist/cli.js";

process.exitCode = await runCommand(process.argv.slice(2));
