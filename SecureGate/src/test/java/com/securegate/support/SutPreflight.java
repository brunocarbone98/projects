package com.securegate.support;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * One-shot reachability check for the system under test (Shipping Hub).
 *
 * <p>Every test in this suite is a black-box integration test that talks to a <em>running</em>
 * Shipping Hub (API on {@code apiBaseUrl}, web on {@code webBaseUrl}). When the stack is down, REST
 * Assured and Selenium fail <em>every</em> test with a raw {@code java.net.ConnectException:
 * Connection refused}, which reads as "all tests failed" even though the test code is fine. That
 * trap is especially easy to hit from the IDE: clicking run on the {@code com.securegate} folder
 * launches the tests directly and — unlike {@code scripts/run-local-stack.ps1} or CI — does not
 * start the stack first.
 *
 * <p>The base classes call these guards in {@code @BeforeAll}, so a down stack produces ONE clear,
 * actionable message (and the JUnit tests are <em>skipped</em> rather than failed) instead of a wall
 * of connection errors. CI always brings the stack up, so the guard is a no-op there.
 *
 * <p>The result is cached per JVM: a test run always uses a fresh forked JVM, so a stack started
 * mid-session is picked up on the next run, never staler than that.
 */
public final class SutPreflight {

  private static final Duration TIMEOUT = Duration.ofSeconds(3);

  private static volatile Boolean apiUp;
  private static volatile Boolean webUp;

  private SutPreflight() {}

  /** True if the Shipping Hub API answers {@code GET /health}. Checked once per JVM. */
  public static boolean isApiUp() {
    Boolean cached = apiUp;
    if (cached == null) {
      cached = reachable(Config.get().apiBaseUrl() + "/health");
      apiUp = cached;
    }
    return cached;
  }

  /** True if the Shipping Hub web app answers on {@code webBaseUrl}. Checked once per JVM. */
  public static boolean isWebUp() {
    Boolean cached = webUp;
    if (cached == null) {
      cached = reachable(Config.get().webBaseUrl());
      webUp = cached;
    }
    return cached;
  }

  /** Actionable message naming the down API and how to start the stack. */
  public static String apiDownMessage() {
    return downMessage("API", Config.get().apiBaseUrl());
  }

  /** Actionable message naming the down web app and how to start the stack. */
  public static String webDownMessage() {
    return downMessage("web app", Config.get().webBaseUrl());
  }

  private static String downMessage(String what, String url) {
    return "Shipping Hub "
        + what
        + " is not reachable at "
        + url
        + ".\n"
        + "These are black-box integration tests: they need a RUNNING Shipping Hub. Start the local\n"
        + "stack first, then re-run:\n"
        + "    pwsh SecureGate/scripts/run-local-stack.ps1            # start the stack\n"
        + "    pwsh SecureGate/scripts/run-local-stack.ps1 -RunTests  # start it and run the suite\n"
        + "See SecureGate/README.md > \"Running from IntelliJ (or any IDE)\".";
  }

  private static boolean reachable(String url) {
    try {
      HttpClient client = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
      HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(TIMEOUT).GET().build();
      HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
      // Any HTTP answer means something is listening; only a 5xx hints the service is broken.
      return response.statusCode() < 500;
    } catch (Exception e) {
      return false;
    }
  }
}
