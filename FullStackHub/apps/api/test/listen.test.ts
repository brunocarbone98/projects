// The API's own entry, src/index.ts, started as the container's `pnpm start` starts it (`tsx
// src/index.ts`) with apps/api/.env.test and a free port: where it listens with API_HOST set (the
// root Dockerfile's 127.0.0.1) and unset (local runs, CI), and what it does when it cannot listen.
// Neither this file nor the API it starts queries the database (/health does not), but it runs under
// the api harness like every other file: vitest.config.ts's globalSetup migrates shipping_hub_test
// and test/setup.ts truncates it before each test, so it needs PostgreSQL and never runs beside
// another api run.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { get } from "node:http";
import { createRequire } from "node:module";
import { connect, createServer, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** tsx's command line, which the `start` script runs. */
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
/** An address no machine of ours has (TEST-NET-3, RFC 5737), so listen() cannot use it. */
const ABSENT_ADDRESS = "203.0.113.7";

interface Api {
  child: ChildProcess;
  /** What it has printed so far, stdout and stderr. */
  output: () => string;
  /** Its exit code (null: ended by a signal), once it has exited. */
  exited: Promise<number | null>;
  /** The same, once its output is all read too. */
  closed: Promise<number | null>;
}

const started: Api[] = [];

afterEach(async () => {
  for (const api of started.splice(0)) await stop(api);
});

function startApi(port: number, host: string | undefined): Api {
  const env: NodeJS.ProcessEnv = { ...process.env, ENV_FILE: ".env.test", PORT: String(port) };
  if (host === undefined) delete env.API_HOST;
  else env.API_HOST = host;
  const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: apiDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  const closed = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
  const api: Api = { child, output: () => output, exited, closed };
  started.push(api);
  return api;
}

function hasExited(api: Api): boolean {
  return api.child.exitCode !== null || api.child.signalCode !== null;
}

/** Waits, at most 20 s, until `done()` holds. */
async function until(api: Api, done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`no ${what} within 20 s; the API said:\n${api.output()}`);
    }
    await new Promise((wake) => setTimeout(wake, 50));
  }
}

/** Waits for the API's listening line, whole, or its exit; then that line must name `url`. */
async function listening(api: Api, url: string): Promise<void> {
  const said = () => /\[api\] listening on \S+\n/.test(api.output());
  await until(api, () => said() || hasExited(api), "listening line");
  expect(api.output()).toContain(`[api] listening on ${url}\n`);
}

async function stop(api: Api): Promise<void> {
  if (!hasExited(api)) api.child.kill("SIGTERM"); // tsx hands it to the API: its own shutdown
  const kill = setTimeout(() => api.child.kill("SIGKILL"), 10_000);
  await api.exited;
  clearTimeout(kill);
}

/** A port nothing listens on, on any interface: the kernel's pick for a listen on all of them. */
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

/** Every address of this machine's interfaces. */
function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) => (entry === undefined ? [] : [entry.address]));
}

/**
 * An address of this machine other than 127.0.0.1, where an API listening on every interface
 * answers and one on loopback only does not: a network interface's (CI's and the cloud sandbox's
 * eth0), else 127.0.0.2, since Linux and Windows answer on all of 127.0.0.0/8 (macOS does not).
 */
function otherLocalAddress(): string {
  const external = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
  if (external) return external.address;
  if (process.platform !== "darwin") return "127.0.0.2";
  throw new Error("this machine has no address but 127.0.0.1 to try: connect it to a network");
}

/** GET /health at host:port, through node:http (never a proxy). */
function health(host: string, port: number): Promise<{ status: number; body: string }> {
  return new Promise((answered, failed) => {
    const request = get({ host, port, path: "/health", timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => answered({ status: response.statusCode ?? 0, body }));
    });
    request.on("timeout", () => request.destroy(new Error(`${host}:${port}: no answer in 5 s`)));
    request.on("error", failed);
  });
}

/** Whether host:port takes a TCP connection (true) or refuses it (false). */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((answered, failed) => {
    const socket = connect({ host, port });
    socket.setTimeout(5_000);
    socket.once("connect", () => {
      socket.destroy();
      answered(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      failed(new Error(`${host}:${port}: neither taken nor refused in 5 s`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") answered(false);
      else failed(error);
    });
  });
}

describe("the API's own entry (src/index.ts, as `pnpm start` runs it)", () => {
  it("with API_HOST=127.0.0.1, as the root Dockerfile sets it, listens on loopback only", async () => {
    const other = otherLocalAddress();
    const port = await freePort();
    const api = startApi(port, "127.0.0.1");
    await listening(api, `http://127.0.0.1:${port}`);

    const answer = await health("127.0.0.1", port);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ status: "ok", service: "api" });
    // any other address of the machine is refused: Railway's private network cannot reach it
    expect(await accepts(other, port), `${other}:${port}`).toBe(false);
  });

  it("with API_HOST unset listens on every interface, as before", async () => {
    const other = otherLocalAddress();
    const port = await freePort();
    const api = startApi(port, undefined);
    await listening(api, `http://localhost:${port}`);

    expect((await health("127.0.0.1", port)).status).toBe(200);
    expect((await health(other, port)).status).toBe(200);
    // IPv6 too where the machine has it (CI's runners; the cloud sandbox has none): every interface
    // is ::, both families, never 0.0.0.0 alone
    if (localAddresses().includes("::1")) expect((await health("::1", port)).status).toBe(200);
  });

  it("with an address this machine does not have, says why and exits 1, never 'listening'", async () => {
    expect(localAddresses()).not.toContain(ABSENT_ADDRESS);
    const port = await freePort();
    const api = startApi(port, ABSENT_ADDRESS);
    await until(api, () => hasExited(api) || api.output().includes("[api] listening"), "exit");
    const code = hasExited(api) ? await api.closed : "still running";

    expect(api.output()).not.toContain("[api] listening");
    expect(code).toBe(1);
    expect(api.output()).toContain(
      `[api] cannot listen on ${ABSENT_ADDRESS}:${port}: listen EADDRNOTAVAIL`,
    );
  });
});
