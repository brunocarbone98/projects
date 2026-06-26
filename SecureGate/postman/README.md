# Postman / Newman — Shipping Hub API

A versioned [Postman](https://www.postman.com/) collection of black-box API checks for Shipping Hub,
runnable interactively in Postman or headless in CI with [Newman](https://github.com/postmanlabs/newman).

It is the exploratory / documentation companion to the automated **Karate** API suite
(`src/test/resources/karate`): the Karate features are the gate that fails the build; this collection
is the hand-runnable, shareable view of the same endpoints.

## Files

| File | What it is |
|---|---|
| `SecureGate.postman_collection.json` | The collection: Health · Tracking · Quote · Auth · Shipments · Wallet, each request with `pm.test` assertions. |
| `SecureGate.local.postman_environment.json` | Points `baseUrl` at a local Shipping Hub (`http://localhost:4000`). |
| `SecureGate.remote.postman_environment.json` | Template for a remote API host — edit `baseUrl`. |

The folders run top-to-bottom: **Auth** registers a fresh customer and stores its `accessToken` as a
collection variable, which **Shipments** and **Wallet** then reuse. So a full run is self-contained
against a seeded Shipping Hub.

## Run it with Newman

```bash
# one-off
npx newman run SecureGate.postman_collection.json \
  -e SecureGate.local.postman_environment.json

# with an HTML report
npx newman run SecureGate.postman_collection.json \
  -e SecureGate.local.postman_environment.json \
  -r cli,htmlextra --reporter-htmlextra-export target/newman/report.html
```

Requires a running Shipping Hub (see the top-level [`README.md`](../README.md) for how to start the
local stack). CI runs this collection as a non-blocking smoke step — see
[`/.github/workflows/securegate-ci.yml`](../../.github/workflows/securegate-ci.yml).

## Run it in Postman

Import both the collection and an environment, select the environment, then **Run collection**.
