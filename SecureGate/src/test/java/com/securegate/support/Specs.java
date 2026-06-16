package com.securegate.support;

import static io.restassured.http.ContentType.JSON;

import io.restassured.builder.RequestSpecBuilder;
import io.restassured.specification.RequestSpecification;

/** Reusable REST Assured request specifications for the Shipping Hub API. */
public final class Specs {

  private Specs() {}

  /** Base spec for the JSON API under {@code /api/v1}. */
  public static RequestSpecification api() {
    return new RequestSpecBuilder()
        .setBaseUri(Config.get().apiBaseUrl())
        .setBasePath("/api/v1")
        .setContentType(JSON)
        .setAccept(JSON)
        .build();
  }

  /** Authenticated variant: the API spec plus a Bearer token. */
  public static RequestSpecification authed(String accessToken) {
    return new RequestSpecBuilder()
        .addRequestSpecification(api())
        .addHeader("Authorization", "Bearer " + accessToken)
        .build();
  }

  /** Spec for root-level endpoints such as {@code /health} (not under {@code /api/v1}). */
  public static RequestSpecification root() {
    return new RequestSpecBuilder()
        .setBaseUri(Config.get().apiBaseUrl())
        .setAccept(JSON)
        .build();
  }
}
