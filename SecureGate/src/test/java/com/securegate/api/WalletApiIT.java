package com.securegate.api;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.equalTo;

import com.securegate.support.Auth;
import com.securegate.support.BaseApiIT;
import com.securegate.support.Specs;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Phase 1 — wallet: balance/ledger contract, top-up, idempotency and authn. */
@DisplayName("Wallet API")
class WalletApiIT extends BaseApiIT {

  @Test
  @DisplayName("a fresh wallet starts empty and matches the contract")
  void freshWalletIsEmpty() {
    Auth.Session user = Auth.registerFresh();
    given()
        .spec(Specs.authed(user.accessToken()))
        .when()
        .get("/wallet")
        .then()
        .statusCode(200)
        .body(matchesJsonSchemaInClasspath("schemas/wallet.json"))
        .body("currency", equalTo("USD"))
        .body("balanceCents", equalTo(0));
  }

  @Test
  @DisplayName("a top-up increases the balance by the amount")
  void topUpIncreasesBalance() {
    Auth.Session user = Auth.registerFresh();
    given()
        .spec(Specs.authed(user.accessToken()))
        .body(Map.of("amountCents", 5000, "idempotencyKey", "topup-" + System.nanoTime()))
        .when()
        .post("/wallet/topup")
        .then()
        .statusCode(200)
        .body("balanceCents", equalTo(5000));
  }

  @Test
  @DisplayName("retrying a top-up with the same idempotency key does not double-credit")
  void topUpIsIdempotent() {
    Auth.Session user = Auth.registerFresh();
    String key = "idem-" + System.nanoTime();
    Map<String, Object> body = Map.of("amountCents", 5000, "idempotencyKey", key);

    given().spec(Specs.authed(user.accessToken())).body(body).post("/wallet/topup").then().statusCode(200);

    // Same key again: the balance must remain 5000, not 10000.
    given()
        .spec(Specs.authed(user.accessToken()))
        .body(body)
        .when()
        .post("/wallet/topup")
        .then()
        .statusCode(200)
        .body("balanceCents", equalTo(5000));
  }

  @Test
  @DisplayName("reading the wallet without a token returns 401")
  void walletWithoutTokenIsUnauthorized() {
    given()
        .spec(Specs.api())
        .when()
        .get("/wallet")
        .then()
        .statusCode(401)
        .body("error.code", equalTo("UNAUTHENTICATED"));
  }
}
