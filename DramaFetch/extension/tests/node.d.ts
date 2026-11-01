// Hand-written declarations of the Node built-ins the extension's tests and runners use — there is
// no @types/node because the extension has no dependencies at all. Only what is used is declared;
// add a member here (never a second declaration of these modules elsewhere) when a test needs it.

declare module "node:test" {
  export interface TestContext {
    readonly name: string;
    skip(message?: string): void;
    diagnostic(message: string): void;
  }
  export interface TestOptions {
    skip?: boolean | string;
    timeout?: number;
  }
  type TestFn = (context: TestContext) => void | Promise<void>;
  export function test(name: string, fn: TestFn): Promise<void>;
  export function test(name: string, options: TestOptions, fn: TestFn): Promise<void>;
  export function describe(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function it(name: string, fn: TestFn): Promise<void>;
  export default test;
}

declare module "node:assert/strict" {
  type Expected = RegExp | object | ((error: unknown) => boolean) | (new (...args: never[]) => unknown);
  function assert(value: unknown, message?: string | Error): asserts value;
  namespace assert {
    function ok(value: unknown, message?: string | Error): asserts value;
    function equal(actual: unknown, expected: unknown, message?: string | Error): void;
    function notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function notDeepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    function throws(fn: () => unknown, expected?: Expected, message?: string | Error): void;
    function doesNotThrow(fn: () => unknown, message?: string | Error): void;
    function rejects(
      block: Promise<unknown> | (() => Promise<unknown>),
      expected?: Expected,
      message?: string | Error,
    ): Promise<void>;
    function match(value: string, pattern: RegExp, message?: string | Error): void;
    function doesNotMatch(value: string, pattern: RegExp, message?: string | Error): void;
    function fail(message?: string | Error): never;
  }
  export default assert;
}

declare module "node:fs" {
  export function readFileSync(path: string | number | URL, encoding: "utf8" | "utf-8"): string;
  export function readFileSync(path: string | number | URL, options: { encoding: "utf8" | "utf-8" }): string;
  export function readFileSync(path: string | number | URL): Uint8Array;
  export function writeFileSync(path: string | number | URL, data: string | Uint8Array): void;
  export function writeSync(fd: number, data: string): number;
  export function writeSync(fd: number, buffer: Uint8Array, offset?: number, length?: number): number;
  export function existsSync(path: string | URL): boolean;
  export function readdirSync(path: string | URL): string[];
}
