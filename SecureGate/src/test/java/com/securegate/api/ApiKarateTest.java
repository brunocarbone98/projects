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
    int threads = Integer.getInteger("sg.karate.threads", 4);

    // Main suite: every feature EXCEPT the load-style @ratelimit one, run in parallel.
    Results main =
        Runner.path("classpath:karate")
            .tags("~@ratelimit")
            .outputCucumberJson(true)
            .parallel(threads);

    int failures = main.getFailCount();
    StringBuilder errors = new StringBuilder(main.getErrorMessages());

    // The rate-limit check is load-style: it exhausts the public tracking endpoint's per-IP budget
    // (default 60 req / 60s). Because every scenario shares the same source IP, it must NOT run
    // concurrently with — or before — the public tracking/health scenarios, or they would receive
    // 429 instead of their asserted 200/400/404. So when opted in (-Dsg.ratelimit=true) we run it
    // on its own, single-threaded, AFTER the main suite has already passed, into a separate report
    // dir. Nothing public-facing runs after it, so there is nothing left to throttle.
    if (Boolean.parseBoolean(System.getProperty("sg.ratelimit", "false"))) {
      Results rateLimit =
          Runner.path("classpath:karate/ratelimit.feature")
              .reportDir("target/karate-reports-ratelimit")
              .parallel(1);
      failures += rateLimit.getFailCount();
      errors.append(System.lineSeparator()).append(rateLimit.getErrorMessages());
    }

    assertEquals(0, failures, errors.toString());
  }
}
