import { ManagedCliTransport } from "./managed-transport.js";
import { runCli } from "./runtime.js";
process.exitCode = await runCli({ environment: "managed", transport: new ManagedCliTransport() });
