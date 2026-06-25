package com.securegate.support;

import io.restassured.RestAssured;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;

/** Base class for API integration tests: configures REST Assured once per class. */
public abstract class BaseApiIT {

  @BeforeAll
  static void configureRestAssured() {
    // Bring the local Shipping Hub up if it is down (no-op when it is already running or when
    // auto-start does not apply), so a green-arrow run from the IDE just works. See SutPreflight.
    SutPreflight.ensureLocalStackReady();
    // Skip (not fail) with one actionable message when the Shipping Hub is not ready — whether the
    // API is down (connection refused) or up but its database is dead (every endpoint 500s) — instead
    // of letting every test blow up. See SutPreflight.
    Assumptions.assumeTrue(SutPreflight.isApiReady(), SutPreflight::apiNotReadyMessage);
    RestAssured.baseURI = Config.get().apiBaseUrl();
    // On an assertion failure, dump the request and response to make diagnosis easy.
    RestAssured.enableLoggingOfRequestAndResponseIfValidationFails();
  }
}
