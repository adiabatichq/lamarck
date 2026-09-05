import { HostCliTransport } from "./host-transport.js";
import { runCli } from "./runtime.js";
process.exitCode = await runCli({ environment: "host", transport: new HostCliTransport() });
