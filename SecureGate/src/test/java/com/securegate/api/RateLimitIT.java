package com.securegate.api;

import static io.restassured.RestAssured.given;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.securegate.support.BaseApiIT;
import com.securegate.support.Config;
import com.securegate.support.Specs;
import org.junit.jupiter.api.AfterAll;
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

  /**
   * Be a good citizen when this class is run inside the full suite (e.g. {@code -DexcludedGroups=}).
   *
   * <p>The aggressive loop above intentionally exhausts the public tracking endpoint's per-IP budget
   * (default 60 requests / 60s window). Because every test shares the same source IP, the later
   * public-tracking tests ({@code TrackingApiIT} and the Cucumber tracking scenarios) would otherwise
   * receive {@code 429} instead of their expected {@code 200/400/404}. Waiting just past the window
   * lets the per-IP budget reset so the rest of the suite gets a clean slate.
   */
  @AfterAll
  static void letRateLimitWindowReset() throws InterruptedException {
    // Window is 60_000 ms on the API; add a small margin to be safe.
    Thread.sleep(63_000);
  }
}
