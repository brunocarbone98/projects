package com.securegate.api;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.greaterThan;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.securegate.support.BaseApiIT;
import com.securegate.support.Payloads;
import com.securegate.support.Specs;
import io.restassured.path.json.JsonPath;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** Phase 1 — public quote endpoint: pricing contract and input validation. */
@Tag("public")
@DisplayName("Public quote API")
class QuoteApiIT extends BaseApiIT {

  @Test
  @DisplayName("a valid quote returns a price and ETA matching the contract")
  void validQuoteReturnsPricing() {
    JsonPath body =
        given()
            .spec(Specs.api())
            .body(Payloads.quote())
            .when()
            .post("/quote")
            .then()
            .statusCode(200)
            .body(matchesJsonSchemaInClasspath("schemas/quote.json"))
            .body("currency", equalTo("USD"))
            .body("priceCents", greaterThan(0))
            .extract()
            .jsonPath();
    assertTrue(
        body.getInt("etaMinDays") <= body.getInt("etaMaxDays"), "etaMinDays must be <= etaMaxDays");
    assertTrue(body.getInt("billableWeightGrams") >= 2000, "billable weight is at least actual");
  }

  @Test
  @DisplayName("a missing destination country is rejected with 400")
  void missingDestinationIsRejected() {
    Map<String, Object> body = new HashMap<>(Payloads.quote());
    body.remove("destinationCountry");
    given()
        .spec(Specs.api())
        .body(body)
        .when()
        .post("/quote")
        .then()
        .statusCode(400)
        .body("error.code", equalTo("VALIDATION_ERROR"));
  }

  @Test
  @DisplayName("an over-limit weight is rejected with 400")
  void overweightIsRejected() {
    Map<String, Object> body = new HashMap<>(Payloads.quote());
    body.put("weightGrams", 80_000); // limit is 70,000
    given()
        .spec(Specs.api())
        .body(body)
        .when()
        .post("/quote")
        .then()
        .statusCode(400)
        .body("error.code", equalTo("VALIDATION_ERROR"));
  }

  @Test
  @DisplayName("an unknown service level is rejected with 400")
  void invalidServiceLevelIsRejected() {
    Map<String, Object> body = new HashMap<>(Payloads.quote());
    body.put("serviceLevel", "PREMIUM");
    given()
        .spec(Specs.api())
        .body(body)
        .when()
        .post("/quote")
        .then()
        .statusCode(400)
        .body("error.code", equalTo("VALIDATION_ERROR"));
  }
}
