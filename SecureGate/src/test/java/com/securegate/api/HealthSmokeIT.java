package com.securegate.api;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.emptyOrNullString;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.not;

import com.securegate.support.BaseApiIT;
import com.securegate.support.Config;
import com.securegate.support.Specs;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * Phase 0 smoke test: the system under test is up and the seeded demo parcel is trackable.
 * Read-only and public, so it is safe to run against any environment (tagged {@code smoke}).
 */
@Tag("smoke")
@Tag("public")
class HealthSmokeIT extends BaseApiIT {

  @Test
  @DisplayName("GET /health reports the API is up")
  void healthIsOk() {
    given()
        .spec(Specs.root())
        .when()
        .get("/health")
        .then()
        .statusCode(200)
        .body("status", equalTo("ok"))
        .body("service", equalTo("api"));
  }

  @Test
  @DisplayName("The seeded demo parcel is publicly trackable")
  void demoParcelIsTrackable() {
    String code = Config.get().demoTrackingCode();
    given()
        .spec(Specs.api())
        .when()
        .get("/tracking/{code}", code)
        .then()
        .statusCode(200)
        .body("trackingCode", equalTo(code))
        .body("status", not(emptyOrNullString()));
  }
}
