package com.securegate.bdd;

import io.restassured.response.Response;

/**
 * Per-scenario shared state, injected into every step class by Cucumber's PicoContainer. Holds the
 * current auth token and the last HTTP response so steps can hand off to one another.
 */
public class World {
  public String accessToken;
  public Response response;
  public String shipmentId;
}
