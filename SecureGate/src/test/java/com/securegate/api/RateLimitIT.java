package com.securegate.api;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.securegate.support.BaseApiIT;
import com.securegate.support.Config;
import com.securegate.support.Specs;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

/**
 * Security check — the public tracking endpoint rate-limits aggressive callers (429).
 *
 * <p>Tagged {@code ratelimit} and EXCLUDED from the default run, because hammering the endpoint
 * consumes the per-IP budget and would interfere with the other public tracking tests. Run it on
 * its own with {@code ./mvnw verify -Dit.test=RateLimitIT -DexcludedGroups=}.
 */
@Tag("ratelimit")
@DisplayName("Public endpoint rate limiting")
class RateLimitIT extends BaseApiIT {

  @Test
  @DisplayName("aggressive tracking requests are throttled with 429 RATE_LIMITED")
  void rateLimitKicksIn() {
    String code = Config.get().demoTrackingCode();
    boolean limited = false;
    for (int i = 0; i < 90 && !limited; i++) {
      int status = given().spec(Specs.api()).get("/tracking/{code}", code).statusCode();
      limited = status == 429;
    }
    assertTrue(limited, "Expected a 429 within 90 rapid requests (default limit is 60/min).");
  }
}
