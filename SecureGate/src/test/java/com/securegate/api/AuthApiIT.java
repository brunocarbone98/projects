package com.securegate.api;

import static io.restassured.RestAssured.given;
import static io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.notNullValue;

import com.securegate.support.Auth;
import com.securegate.support.BaseApiIT;
import com.securegate.support.Config;
import com.securegate.support.Specs;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Phase 1 — authentication: registration, login, token refresh/rotation and /me, with negatives. */
@DisplayName("Authentication API")
class AuthApiIT extends BaseApiIT {

  @Test
  @DisplayName("registering a new user returns 201 with a user + tokens (contract)")
  void registerReturnsUserAndTokens() {
    String email = "sg+" + System.nanoTime() + "@securegate.test";
    given()
        .spec(Specs.api())
        .body(Map.of("email", email, "password", "Password123!", "name", "New User"))
        .when()
        .post("/auth/register")
        .then()
        .statusCode(201)
        .body(matchesJsonSchemaInClasspath("schemas/auth-response.json"))
        .body("user.email", equalTo(email))
        .body("user.role", equalTo("CUSTOMER"))
        .body("tokens.accessToken", notNullValue());
  }

  @Test
  @DisplayName("registering an already-taken email returns 409 EMAIL_TAKEN")
  void duplicateEmailIsRejected() {
    given()
        .spec(Specs.api())
        .body(Map.of("email", Config.get().customerEmail(), "password", "Password123!", "name", "Dup"))
        .when()
        .post("/auth/register")
        .then()
        .statusCode(409)
        .body("error.code", equalTo("EMAIL_TAKEN"));
  }

  @Test
  @DisplayName("logging in with the right credentials returns tokens")
  void loginSucceeds() {
    given()
        .spec(Specs.api())
        .body(Map.of("email", Config.get().customerEmail(), "password", Config.get().customerPassword()))
        .when()
        .post("/auth/login")
        .then()
        .statusCode(200)
        .body("user.email", equalTo(Config.get().customerEmail()))
        .body("tokens.accessToken", notNullValue());
  }

  @Test
  @DisplayName("a wrong password returns 401 INVALID_CREDENTIALS")
  void loginWithWrongPasswordIsRejected() {
    given()
        .spec(Specs.api())
        .body(Map.of("email", Config.get().customerEmail(), "password", "wrong-password"))
        .when()
        .post("/auth/login")
        .then()
        .statusCode(401)
        .body("error.code", equalTo("INVALID_CREDENTIALS"));
  }

  @Test
  @DisplayName("a malformed email is rejected with 400 VALIDATION_ERROR")
  void loginWithMalformedEmailIsRejected() {
    given()
        .spec(Specs.api())
        .body(Map.of("email", "not-an-email", "password", "whatever"))
        .when()
        .post("/auth/login")
        .then()
        .statusCode(400)
        .body("error.code", equalTo("VALIDATION_ERROR"));
  }

  @Test
  @DisplayName("a refresh token rotates and the old token is then rejected (401 INVALID_TOKEN)")
  void refreshRotatesAndRevokesOldToken() {
    Auth.Session session = Auth.registerFresh();

    // First refresh: succeeds and rotates the token.
    String rotated =
        given()
            .spec(Specs.api())
            .body(Map.of("refreshToken", session.refreshToken()))
            .when()
            .post("/auth/refresh")
            .then()
            .statusCode(200)
            .body("accessToken", notNullValue())
            .body("refreshToken", notNullValue())
            .extract()
            .path("refreshToken");

    org.junit.jupiter.api.Assertions.assertNotEquals(session.refreshToken(), rotated);

    // Reusing the original (now-revoked) refresh token must fail.
    given()
        .spec(Specs.api())
        .body(Map.of("refreshToken", session.refreshToken()))
        .when()
        .post("/auth/refresh")
        .then()
        .statusCode(401)
        .body("error.code", equalTo("INVALID_TOKEN"));
  }

  @Test
  @DisplayName("GET /auth/me with a valid token returns the current user")
  void meReturnsCurrentUser() {
    Auth.Session session = Auth.registerFresh();
    given()
        .spec(Specs.authed(session.accessToken()))
        .when()
        .get("/auth/me")
        .then()
        .statusCode(200)
        .body("user.id", equalTo(session.userId()))
        .body("user.email", equalTo(session.email()));
  }

  @Test
  @DisplayName("GET /auth/me without a token returns 401 UNAUTHENTICATED")
  void meWithoutTokenIsUnauthorized() {
    given()
        .spec(Specs.api())
        .when()
        .get("/auth/me")
        .then()
        .statusCode(401)
        .body("error.code", equalTo("UNAUTHENTICATED"));
  }

  @Test
  @DisplayName("GET /auth/me with a tampered token returns 401")
  void meWithTamperedTokenIsUnauthorized() {
    String tampered = Auth.customerToken() + "x"; // breaks the JWT signature
    given()
        .spec(Specs.authed(tampered))
        .when()
        .get("/auth/me")
        .then()
        .statusCode(401);
  }
}
