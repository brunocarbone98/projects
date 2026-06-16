package com.securegate.api;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.emptyOrNullString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.everyItem;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.in;
import static org.hamcrest.Matchers.not;

import com.securegate.support.BaseApiIT;
import com.securegate.support.Config;
import com.securegate.support.Specs;
import com.securegate.support.TrackingCodes;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/** Phase 1 — public tracking endpoint: contract, validation and not-found behaviour. */
@Tag("public")
@DisplayName("Public tracking API")
class TrackingApiIT extends BaseApiIT {

  @Test
  @DisplayName("the seeded code returns the tracking timeline and matches the contract")
  void validCodeReturnsTimeline() {
    String code = Config.get().demoTrackingCode();
    given()
        .spec(Specs.api())
        .when()
        .get("/tracking/{code}", code)
        .then()
        .statusCode(200)
        .body(matchesJsonSchemaInClasspath("schemas/public-tracking.json"))
        .body("trackingCode", equalTo(code))
        .body("serviceLevel", in(List.of("EXPRESS", "STANDARD", "ECONOMY")))
        .body("origin.country", not(emptyOrNullString()))
        .body("destination.country", not(emptyOrNullString()))
        .body("events.size()", greaterThan(0))
        .body("events.status", everyItem(not(emptyOrNullString())));
  }

  @Test
  @DisplayName("a malformed code is rejected with 400 VALIDATION_ERROR")
  void malformedCodeIsRejected() {
    given()
        .spec(Specs.api())
        .when()
        .get("/tracking/{code}", TrackingCodes.MALFORMED)
        .then()
        .statusCode(400)
        .body("error.code", equalTo("VALIDATION_ERROR"));
  }

  @Test
  @DisplayName("a well-formed code with a wrong check digit is not found (404)")
  void wrongCheckDigitIsNotFound() {
    given()
        .spec(Specs.api())
        .when()
        .get("/tracking/{code}", TrackingCodes.withWrongCheckDigit(2026, 1001))
        .then()
        .statusCode(404)
        .body("error.code", equalTo("NOT_FOUND"));
  }

  @Test
  @DisplayName("a valid but unknown code returns 404 NOT_FOUND")
  void unknownCodeIsNotFound() {
    given()
        .spec(Specs.api())
        .when()
        .get("/tracking/{code}", TrackingCodes.build(2026, 987654))
        .then()
        .statusCode(404)
        .body("error.code", equalTo("NOT_FOUND"));
  }
}
