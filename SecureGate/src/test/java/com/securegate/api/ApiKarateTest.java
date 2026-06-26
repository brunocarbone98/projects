package com.securegate.api;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.intuit.karate.Results;
import com.intuit.karate.Runner;
import com.securegate.support.SutPreflight;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Canonical entrypoint for the Karate API suite — the one Maven (Surefire) runs during {@code mvn
 * verify}. It executes every feature under {@code classpath:karate} in parallel and writes the
 * Karate HTML report to {@code target/karate-reports}.
 *
 * <p>The {@code @ratelimit} feature is load-style (it consumes the public endpoint's per-IP budget),
 * so it is excluded by default; opt in with {@code -Dsg.ratelimit=true}. Thread count is tunable
 * with {@code -Dsg.karate.threads=N} (default 4).
 *
 * <p>Like the rest of the black-box suite, it first makes sure the Shipping Hub is reachable: a down
 * stack <em>skips</em> the run with one actionable message (see {@link SutPreflight}) instead of
 * failing every scenario with a raw connection error.
 */
class ApiKarateTest {

  @BeforeAll
  static void requireShippingHub() {
    // Bring the local Shipping Hub up if it is down (no-op when already running or not applicable).
    SutPreflight.ensureLocalStackReady();
    Assumptions.assumeTrue(SutPreflight.isApiReady(), SutPreflight::apiNotReadyMessage);
  }

  @Test
  void runApiSuite() {
    boolean includeRateLimit = Boolean.parseBoolean(System.getProperty("sg.ratelimit", "false"));
    int threads = Integer.getInteger("sg.karate.threads", 4);

    Results results =
        (includeRateLimit
                ? Runner.path("classpath:karate")
                : Runner.path("classpath:karate").tags("~@ratelimit"))
            .outputCucumberJson(true)
            .parallel(threads);

    assertEquals(0, results.getFailCount(), results.getErrorMessages());
  }
}
