#!/usr/bin/env node

import { runCliEntrypoint } from "./cli.js";

await runCliEntrypoint({ commandName: "planrelay" });
