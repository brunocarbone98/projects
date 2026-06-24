package com.securegate.support;

import io.restassured.RestAssured;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;

/** Base class for API integration tests: configures REST Assured once per class. */
public abstract class BaseApiIT {

  @BeforeAll
  static void configureRestAssured() {
    // Skip (not fail) with one actionable message when the Shipping Hub is down, instead of letting
    // every test blow up with a raw "Connection refused". See SutPreflight.
    Assumptions.assumeTrue(SutPreflight.isApiUp(), SutPreflight::apiDownMessage);
    RestAssured.baseURI = Config.get().apiBaseUrl();
    // On an assertion failure, dump the request and response to make diagnosis easy.
    RestAssured.enableLoggingOfRequestAndResponseIfValidationFails();
  }
}
