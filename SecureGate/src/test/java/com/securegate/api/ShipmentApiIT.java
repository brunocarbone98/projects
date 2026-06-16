package com.securegate.api;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.matchesRegex;

import com.securegate.support.Auth;
import com.securegate.support.BaseApiIT;
import com.securegate.support.Payloads;
import com.securegate.support.Specs;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Phase 1 — shipments: create/read/list, plus authn and authz (owner-scoped) negatives. */
@DisplayName("Shipments API")
class ShipmentApiIT extends BaseApiIT {

  private static final String TRACKING_REGEX = "^PTY-\\d{4}-\\d{6}-\\d$";

  @Test
  @DisplayName("a signed-in customer can create a shipment (201, CREATED, contract)")
  void createShipment() {
    Auth.Session user = Auth.registerFresh();
    given()
        .spec(Specs.authed(user.accessToken()))
        .body(Payloads.newShipment())
        .when()
        .post("/shipments")
        .then()
        .statusCode(201)
        .body(matchesJsonSchemaInClasspath("schemas/shipment.json"))
        .body("status", equalTo("CREATED"))
        .body("trackingCode", matchesRegex(TRACKING_REGEX))
        .body("currency", equalTo("USD"));
  }

  @Test
  @DisplayName("a customer can read back and list their own shipment")
  void readAndListOwnShipment() {
    Auth.Session user = Auth.registerFresh();
    String id =
        given()
            .spec(Specs.authed(user.accessToken()))
            .body(Payloads.newShipment())
            .post("/shipments")
            .then()
            .statusCode(201)
            .extract()
            .path("id");

    given()
        .spec(Specs.authed(user.accessToken()))
        .when()
        .get("/shipments/{id}", id)
        .then()
        .statusCode(200)
        .body("id", equalTo(id));

    given()
        .spec(Specs.authed(user.accessToken()))
        .when()
        .get("/shipments")
        .then()
        .statusCode(200)
        .body("page", equalTo(1))
        .body("data.id", org.hamcrest.Matchers.hasItem(id));
  }

  @Test
  @DisplayName("a customer cannot read another customer's shipment (404, owner-scoped)")
  void cannotReadAnotherUsersShipment() {
    Auth.Session owner = Auth.registerFresh();
    String id =
        given()
            .spec(Specs.authed(owner.accessToken()))
            .body(Payloads.newShipment())
            .post("/shipments")
            .then()
            .statusCode(201)
            .extract()
            .path("id");

    Auth.Session intruder = Auth.registerFresh();
    given()
        .spec(Specs.authed(intruder.accessToken()))
        .when()
        .get("/shipments/{id}", id)
        .then()
        .statusCode(404);
  }

  @Test
  @DisplayName("creating a shipment without a token returns 401")
  void createWithoutTokenIsUnauthorized() {
    given()
        .spec(Specs.api())
        .body(Payloads.newShipment())
        .when()
        .post("/shipments")
        .then()
        .statusCode(401)
        .body("error.code", equalTo("UNAUTHENTICATED"));
  }

  @Test
  @DisplayName("a customer cannot register a tracking event (403 FORBIDDEN — staff only)")
  void customerCannotRegisterEvent() {
    Auth.Session user = Auth.registerFresh();
    String id =
        given()
            .spec(Specs.authed(user.accessToken()))
            .body(Payloads.newShipment())
            .post("/shipments")
            .then()
            .statusCode(201)
            .extract()
            .path("id");

    given()
        .spec(Specs.authed(user.accessToken()))
        .body(Map.of("status", "LABEL_PAID"))
        .when()
        .post("/shipments/{id}/events", id)
        .then()
        .statusCode(403)
        .body("error.code", equalTo("FORBIDDEN"));
  }
}
