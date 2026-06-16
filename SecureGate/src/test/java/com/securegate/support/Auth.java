package com.securegate.support;

import static io.restassured.RestAssured.given;

import io.restassured.path.json.JsonPath;
import java.util.Map;

/** Authentication helpers: obtain tokens and freshly-registered, isolated test users. */
public final class Auth {

  private Auth() {}

  /** Logs in and returns the access token (fails the test if login is not 200). */
  public static String login(String email, String password) {
    return given()
        .spec(Specs.api())
        .body(Map.of("email", email, "password", password))
        .when()
        .post("/auth/login")
        .then()
        .statusCode(200)
        .extract()
        .path("tokens.accessToken");
  }

  /** Access token for the seeded demo customer. */
  public static String customerToken() {
    return login(Config.get().customerEmail(), Config.get().customerPassword());
  }

  /** Access token for the seeded admin. */
  public static String adminToken() {
    return login(Config.get().adminEmail(), Config.get().adminPassword());
  }

  /**
   * Registers a brand-new, unique CUSTOMER and returns its session. Using a fresh user per test
   * keeps tests isolated (own shipments, own wallet) and safe to run repeatedly.
   */
  public static Session registerFresh() {
    String email =
        "sg+" + System.currentTimeMillis() + "-" + (int) (Math.random() * 1_000_000) + "@securegate.test";
    JsonPath body =
        given()
            .spec(Specs.api())
            .body(Map.of("email", email, "password", "Password123!", "name", "SecureGate Bot"))
            .when()
            .post("/auth/register")
            .then()
            .statusCode(201)
            .extract()
            .jsonPath();
    return new Session(
        email,
        body.getString("user.id"),
        body.getString("tokens.accessToken"),
        body.getString("tokens.refreshToken"));
  }

  /** A registered user's identity and tokens. */
  public record Session(String email, String userId, String accessToken, String refreshToken) {}
}
