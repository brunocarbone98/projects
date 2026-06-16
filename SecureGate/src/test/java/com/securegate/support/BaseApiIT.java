package com.securegate.support;

import io.restassured.RestAssured;
import org.junit.jupiter.api.BeforeAll;

/** Base class for API integration tests: configures REST Assured once per class. */
public abstract class BaseApiIT {

  @BeforeAll
  static void configureRestAssured() {
    RestAssured.baseURI = Config.get().apiBaseUrl();
    // On an assertion failure, dump the request and response to make diagnosis easy.
    RestAssured.enableLoggingOfRequestAndResponseIfValidationFails();
  }
}
