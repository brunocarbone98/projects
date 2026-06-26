package com.securegate.api;

import com.intuit.karate.junit5.Karate;

/**
 * Per-feature Karate runners for IDE convenience (green-arrow a single API feature). These use
 * Karate's {@code @Karate.Test} JUnit 5 extension, which gives rich per-scenario reporting in the
 * IDE.
 *
 * <p>Deliberately <em>not</em> named {@code *Test}, so Maven Surefire ignores it: the parallel
 * {@link ApiKarateTest} is the build entrypoint, and running every feature twice (here and there)
 * would be wasteful. The {@code @ratelimit} feature is opt-in and only wired through
 * {@link ApiKarateTest} with {@code -Dsg.ratelimit=true}. These runners assume a running Shipping
 * Hub (no auto-start/skip guard); use {@link ApiKarateTest} for the guarded run.
 */
class ApiFeatureRunners {

  @Karate.Test
  Karate health() {
    return Karate.run("classpath:karate/health.feature");
  }

  @Karate.Test
  Karate tracking() {
    return Karate.run("classpath:karate/tracking.feature");
  }

  @Karate.Test
  Karate quote() {
    return Karate.run("classpath:karate/quote.feature");
  }

  @Karate.Test
  Karate auth() {
    return Karate.run("classpath:karate/auth.feature");
  }

  @Karate.Test
  Karate shipment() {
    return Karate.run("classpath:karate/shipment.feature");
  }

  @Karate.Test
  Karate wallet() {
    return Karate.run("classpath:karate/wallet.feature");
  }
}
