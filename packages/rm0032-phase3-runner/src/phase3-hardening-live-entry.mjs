import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXACT_NODE_VERSION = "v24.15.0";
const MAX_CARRIER_BYTES = 65_536;
const STARTUP_BINDING_PATH = "C:\\ProgramData\\DecadansNeurobro\\startup-trust-v1\\accepted-launchbinding-v1.json";
const BOOTSTRAP_URL = "decadans-c1r-ts://module/phase3-hardening-bootstrap-v1.ts";
const MODULES = Object.freeze([
  Object.freeze({ path: "phase3-hardening-runtime-contract-v1.mjs", url: "decadans-c1r-ts://module/phase3-hardening-runtime-contract-v1.mjs", bytes: 25265, sha256: "5dee2857cb4bb297ccc52e14b4bf9797485f19e5004888b35a8cd8759e298359", format: "module" }),
  Object.freeze({
    path: "contract.ts",
    url: "decadans-c1r-ts://module/contract.ts",
    bytes: 26875,
    sha256: "d408c8033bce47f0b29ed9081b41fd0a6342f804d007e1496f293abeb25befcf",
  }),
  Object.freeze({
    path: "phase3-hardening-bootstrap-v1.ts",
    url: BOOTSTRAP_URL,
    bytes: 15388,
    sha256: "3201e65eb210e6b08ae554d2449332024a7b2301bed3832c5299652a4feb3709",
  }),
  Object.freeze({
    path: "phase3-hardening-controller-v2.ts",
    url: "decadans-c1r-ts://module/phase3-hardening-controller-v2.ts",
    bytes: 50770,
    sha256: "e0b1890d2c2c075d977e05ffe0ea75685f24228dcbdc0f034b2f12965bb9a407",
  }),
  Object.freeze({
    path: "phase3-hardening-controller-core.ts",
    url: "decadans-c1r-ts://module/phase3-hardening-controller-core.ts",
    bytes: 3732,
    sha256: "99bd91fc54e9ea1547312e8350cd69692a876065178f2eb62136157d173c1bbc",
  }),
  Object.freeze({
    path: "phase3-native-observer-adapter-v1.ts",
    url: "decadans-c1r-ts://module/phase3-native-observer-adapter-v1.ts",
    bytes: 66488,
    sha256: "762c1ad55bace8d8406156db62be807cb16cd514f454edd65c412ceade6703a5",
  }),
  Object.freeze({
    path: "phase3-native-observer-production-transport-v1.ts",
    url: "decadans-c1r-ts://module/phase3-native-observer-production-transport-v1.ts",
    bytes: 29625,
    sha256: "1b9ba450b64b556eb54dd9703c52d1421ef3ecacf514322eb7ae5f3d6f042bde",
  }),
  Object.freeze({
    path: "rust-sidecar-adapter.ts",
    url: "decadans-c1r-ts://module/rust-sidecar-adapter.ts",
    bytes: 26741,
    sha256: "d021ccbcc79c5eb6c5e835b828d63d331322c5a3e4ffaedc4de09a9ce22080b1",
  }),
]);

const U = Object.freeze(Object.fromEntries(MODULES.map((module) => [module.path, module.url])));
const BUILTIN_URLS = Object.freeze(new Set([
  "node:child_process",
  "node:crypto",
  "node:events",
  "node:fs/promises",
  "node:path",
  "node:stream",
  "node:url",
]));

function edge(parentURL, specifier, targetURL) {
  return Object.freeze({ parentURL, specifier, targetURL });
}

const EDGES = Object.freeze([
  edge(import.meta.url, U["phase3-hardening-runtime-contract-v1.mjs"], U["phase3-hardening-runtime-contract-v1.mjs"]),
  edge(U["phase3-hardening-runtime-contract-v1.mjs"], "node:crypto", "node:crypto"),
  edge(U["phase3-hardening-runtime-contract-v1.mjs"], "node:path", "node:path"),
  edge(U["phase3-hardening-controller-v2.ts"], "./phase3-hardening-runtime-contract-v1.mjs", U["phase3-hardening-runtime-contract-v1.mjs"]),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./phase3-hardening-runtime-contract-v1.mjs", U["phase3-hardening-runtime-contract-v1.mjs"]),
  edge(import.meta.url, BOOTSTRAP_URL, BOOTSTRAP_URL),
  edge(U["contract.ts"], "node:crypto", "node:crypto"),
  edge(U["contract.ts"], "node:path", "node:path"),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "node:crypto", "node:crypto"),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "node:fs/promises", "node:fs/promises"),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "node:path", "node:path"),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "node:url", "node:url"),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "node:child_process", "node:child_process"),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./contract.ts", U["contract.ts"]),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./phase3-hardening-controller-v2.ts", U["phase3-hardening-controller-v2.ts"]),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./phase3-native-observer-adapter-v1.ts", U["phase3-native-observer-adapter-v1.ts"]),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./phase3-native-observer-production-transport-v1.ts", U["phase3-native-observer-production-transport-v1.ts"]),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./rust-sidecar-adapter.ts", U["rust-sidecar-adapter.ts"]),
  edge(U["phase3-hardening-bootstrap-v1.ts"], "./phase3-hardening-controller-core.ts", U["phase3-hardening-controller-core.ts"]),
  edge(U["phase3-hardening-controller-v2.ts"], "./contract.ts", U["contract.ts"]),
  edge(U["phase3-hardening-controller-v2.ts"], "node:path", "node:path"),
  edge(U["phase3-hardening-controller-v2.ts"], "./rust-sidecar-adapter.ts", U["rust-sidecar-adapter.ts"]),
  edge(U["phase3-hardening-controller-v2.ts"], "./phase3-hardening-controller-core.ts", U["phase3-hardening-controller-core.ts"]),
  edge(U["phase3-hardening-controller-core.ts"], "./rust-sidecar-adapter.ts", U["rust-sidecar-adapter.ts"]),
  edge(U["phase3-native-observer-adapter-v1.ts"], "node:crypto", "node:crypto"),
  edge(U["phase3-native-observer-production-transport-v1.ts"], "./phase3-native-observer-adapter-v1.ts", U["phase3-native-observer-adapter-v1.ts"]),
  edge(U["rust-sidecar-adapter.ts"], "node:child_process", "node:child_process"),
  edge(U["rust-sidecar-adapter.ts"], "node:events", "node:events"),
  edge(U["rust-sidecar-adapter.ts"], "node:fs/promises", "node:fs/promises"),
  edge(U["rust-sidecar-adapter.ts"], "node:path", "node:path"),
  edge(U["rust-sidecar-adapter.ts"], "node:stream", "node:stream"),
  edge(U["rust-sidecar-adapter.ts"], "./contract.ts", U["contract.ts"]),
]);

const EDGE_TARGETS = new Map(EDGES.map(({ parentURL, specifier, targetURL }) => [
  `${parentURL}\u0000${specifier}`,
  targetURL,
]));
let bootstrapStarted = false;
let activeHooks;

export async function runPhase3HardeningLiveEntry() {
  requireDirectEntry();
  if (bootstrapStarted) throw new Error("phase3-live-entry-bootstrap-once-refused");
  bootstrapStarted = true;

  const entryPath = fileURLToPath(import.meta.url);
  const sourceDirectory = dirname(entryPath);
  const retainedSources = new Map();
  const retainedFormats = new Map();
  for (const module of MODULES) {
    const absolutePath = win32.join(sourceDirectory, module.path);
    const metadata = lstatSync(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== module.bytes) {
      throw new Error(`phase3-live-entry-module-metadata-refused:${module.path}`);
    }
    const rawBytes = readFileSync(absolutePath);
    if (rawBytes.byteLength !== module.bytes || sha256Hex(rawBytes) !== module.sha256) {
      throw new Error(`phase3-live-entry-module-hash-refused:${module.path}`);
    }
    if (rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf) {
      throw new Error(`phase3-live-entry-module-bom-refused:${module.path}`);
    }
    retainedSources.set(module.url, new TextDecoder("utf-8", { fatal: true }).decode(rawBytes));
    retainedFormats.set(module.url, module.format ?? "module-typescript");
  }

  activeHooks = registerHooks({
    resolve(specifier, context) {
      const targetURL = EDGE_TARGETS.get(`${context.parentURL ?? ""}\u0000${specifier}`);
      if (targetURL === undefined) {
        throw new Error(`phase3-live-entry-resolve-refused:${context.parentURL ?? "<none>"}:${specifier}`);
      }
      return { url: targetURL, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      const retainedSource = retainedSources.get(url);
      if (retainedSource !== undefined) {
        return { format: retainedFormats.get(url), source: retainedSource, shortCircuit: true };
      }
      if (BUILTIN_URLS.has(url)) return nextLoad(url, context);
      throw new Error(`phase3-live-entry-load-refused:${url}`);
    },
  });

  const bootstrap = await import(BOOTSTRAP_URL);
  if (Object.keys(bootstrap).length !== 1
    || typeof bootstrap.runPhase3HardeningBootstrapV1 !== "function") {
    throw new Error("phase3-live-entry-bootstrap-export-refused");
  }
  const repositoryRoot = win32.resolve(sourceDirectory, "..", "..", "..");
  const carrierPath = win32.join(
    repositoryRoot,
    "project",
    "verification",
    "rm-0032-phase3-live-hardening-carrier.json",
  );
  const carrierMetadata = lstatSync(carrierPath);
  if (!carrierMetadata.isFile() || carrierMetadata.isSymbolicLink()
    || carrierMetadata.size < 1 || carrierMetadata.size > MAX_CARRIER_BYTES) {
    throw new Error("phase3-live-entry-carrier-metadata-refused");
  }
  const capturedCarrierBytes = readFileSync(carrierPath);
  if (capturedCarrierBytes.byteLength !== carrierMetadata.size) {
    throw new Error("phase3-live-entry-carrier-read-drift-refused");
  }
  const startupMetadata = lstatSync(STARTUP_BINDING_PATH);
  if (!startupMetadata.isFile() || startupMetadata.isSymbolicLink() || startupMetadata.size < 1 || startupMetadata.size > MAX_CARRIER_BYTES) throw new Error("phase3-live-entry-startup-metadata-refused");
  const capturedStartupBindingBytes = readFileSync(STARTUP_BINDING_PATH);
  if (capturedStartupBindingBytes.byteLength !== startupMetadata.size) throw new Error("phase3-live-entry-startup-read-drift-refused");
  const contract = await import(U["phase3-hardening-runtime-contract-v1.mjs"]);
  const startup = contract.parseExternalStartupBinding(capturedStartupBindingBytes);
  if (contract.sha256(capturedCarrierBytes) !== startup.carrier.sha256 || capturedCarrierBytes.byteLength !== startup.carrier.bytes) throw new Error("phase3-live-entry-startup-carrier-refused");
  if (startup.liveEntry.path !== entryPath || startup.node.path !== process.execPath || startup.repositoryRoot !== repositoryRoot) throw new Error("phase3-live-entry-startup-path-refused");
  return bootstrap.runPhase3HardeningBootstrapV1(Buffer.from(capturedCarrierBytes), Buffer.from(capturedStartupBindingBytes));
}

function requireDirectEntry() {
  if (process.version !== EXACT_NODE_VERSION || process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("phase3-live-entry-runtime-refused");
  }
  const entryPath = fileURLToPath(import.meta.url);
  if (process.execArgv.length !== 0 || Object.keys(process.env).sort().join("|") !== "SystemRoot|WINDIR" || process.env.SystemRoot !== "C:\\Windows" || process.env.WINDIR !== "C:\\Windows") throw new Error("phase3-live-entry-environment-refused");
  if (process.argv.length !== 2 || process.argv[0] !== process.execPath || process.argv[1] !== entryPath) {
    throw new Error("phase3-live-entry-argv-refused");
  }
  if (pathToFileURL(process.argv[1]).href !== import.meta.url) {
    throw new Error("phase3-live-entry-direct-identity-refused");
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv.length === 2 && process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runPhase3HardeningLiveEntry().then(
    (result) => { if (result.outcome !== "known-clear") process.exitCode = 1; },
    () => { process.exitCode = 1; },
  );
}
