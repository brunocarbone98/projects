/*
 * Karate global configuration for the SecureGate API suite.
 *
 * SecureGate is a BLACK-BOX client of Shipping Hub: every feature drives the running API over HTTP
 * only. The target environment is chosen with -Denv=local|live (default `local`); any base URL or
 * credential can be overridden from the command line, e.g. -DapiBaseUrl=http://host:4000.
 *
 * The returned object is visible as variables in every feature (config.apiBaseUrl -> apiBaseUrl).
 */
function fn() {
  // Resolve the environment from -Dkarate.env, then -Denv, defaulting to local.
  var env = karate.env || karate.properties['env'] || java.lang.System.getProperty('env') || 'local';
  karate.configure('connectTimeout', 10000);
  karate.configure('readTimeout', 20000);

  // Per-environment defaults. Note: the live Railway deploy exposes only the Next.js web; its
  // Express API is internal, so the API suite always targets a LOCAL Shipping Hub. `live` is kept
  // for completeness and for pointing ad-hoc runs at a remote API.
  var config = {
    env: env,
    apiBaseUrl: 'http://localhost:4000',
    webBaseUrl: 'http://localhost:3000',
    demoTrackingCode: 'PTY-2026-001001-0',
    customerEmail: 'ana@example.com',
    customerPassword: 'Password123!',
    adminEmail: 'admin@shippinghub.test',
    adminPassword: 'Password123!'
  };

  if (env === 'live') {
    config.apiBaseUrl = 'https://shipping-hub.up.railway.app';
    config.webBaseUrl = 'https://shipping-hub.up.railway.app';
  }

  // Command-line overrides (-DapiBaseUrl=..., -DdemoTrackingCode=..., etc.).
  ['apiBaseUrl', 'webBaseUrl', 'demoTrackingCode', 'customerEmail', 'customerPassword',
   'adminEmail', 'adminPassword'].forEach(function (key) {
    var override = karate.properties[key];
    if (override) {
      config[key] = override;
    }
  });

  // The API mounts its JSON endpoints under /api/v1; /health sits at the root.
  config.apiV1 = config.apiBaseUrl + '/api/v1';

  // Reuse the project's Java tracking-code helper (a faithful port of Shipping Hub's Luhn logic),
  // so features can build codes the API must accept and codes it must reject.
  config.TrackingCodes = Java.type('com.securegate.support.TrackingCodes');

  // A unique e-mail for registering throwaway, isolated customers.
  config.freshEmail = function () {
    return 'sg+' + java.lang.System.nanoTime() + '@securegate.test';
  };

  return config;
}
