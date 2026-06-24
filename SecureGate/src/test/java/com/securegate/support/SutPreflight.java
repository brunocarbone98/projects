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
 * <p>The guard distinguishes two failure modes, because they need different fixes:
 *
 * <ul>
 *   <li><b>API process down</b> — nothing answers {@code /health}. Start the stack.
 *   <li><b>API up but its database is down</b> — {@code /health} is fine (it touches no DB) yet a
 *       real data read returns {@code 5xx}, so every endpoint 500s. On Windows the bundled
 *       PostgreSQL occasionally crashes (Windows exception {@code 0xC0000142}); the Express API
 *       keeps running against a dead database. A plain {@code /health} probe cannot see this, which
 *       is exactly how a down database used to slip past the guard and produce a wall of 500s.
 * </ul>
 *
 * <p>The base classes and the BDD {@code @Before} hook call {@link #isApiReady()} /
 * {@link #apiNotReadyMessage()}, so either failure mode produces ONE clear, actionable message (and
 * every test is <em>skipped</em> rather than failed) instead of a wall of errors. CI always brings
 * the stack up, so the guard is a no-op there.
 *
 * <p>Each probe is cached per JVM: a test run always uses a fresh forked JVM, so a stack started (or
 * a database restarted) mid-session is picked up on the next run, never staler than that.
 */
public final class SutPreflight {

  private static final Duration TIMEOUT = Duration.ofSeconds(5);

  private static volatile Boolean apiReachable;
  private static volatile Boolean apiDbHealthy;
  private static volatile Boolean webUp;

  private SutPreflight() {}

  /** True if the Shipping Hub API process answers {@code GET /health}. Checked once per JVM. */
  public static boolean isApiUp() {
    Boolean cached = apiReachable;
    if (cached == null) {
      cached = reachable(Config.get().apiBaseUrl() + "/health");
      apiReachable = cached;
    }
    return cached;
  }

  /**
   * True only if the API is up <em>and</em> its database answers a real read. This is the guard the
   * test base classes should use: a 200 here means the suite has a fully working Shipping Hub to
   * talk to, not just a process that 500s on every data-backed call.
   */
  public static boolean isApiReady() {
    return isApiUp() && isDbHealthy();
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

  /**
   * True if a real DB-backed read succeeds: a {@code GET} of the seeded demo tracking code. A {@code
   * 5xx} (the database is down) is "not healthy"; any other answer ({@code 200/404/429}) means the
   * API can reach its database. Checked once per JVM.
   */
  private static boolean isDbHealthy() {
    Boolean cached = apiDbHealthy;
    if (cached == null) {
      cached =
          reachable(Config.get().apiBaseUrl() + "/api/v1/tracking/" + Config.get().demoTrackingCode());
      apiDbHealthy = cached;
    }
    return cached;
  }

  /** Names the actual reason the API is not ready: process down vs. its database down. */
  public static String apiNotReadyMessage() {
    return isApiUp() ? apiDbDownMessage() : apiDownMessage();
  }

  /** Actionable message naming the down API and how to start the stack. */
  public static String apiDownMessage() {
    return downMessage("API", Config.get().apiBaseUrl());
  }

  /** Actionable message naming the down web app and how to start the stack. */
  public static String webDownMessage() {
    return downMessage("web app", Config.get().webBaseUrl());
  }

  private static String apiDbDownMessage() {
    return "Shipping Hub API is up at "
        + Config.get().apiBaseUrl()
        + " but its DATABASE is not responding: a real read\n"
        + "(GET /api/v1/tracking/"
        + Config.get().demoTrackingCode()
        + ") returned a 5xx. The API process is running but cannot reach\n"
        + "PostgreSQL, so every data-backed endpoint returns 500. On Windows the bundled PostgreSQL\n"
        + "occasionally crashes (Windows exception 0xC0000142, visible in %USERPROFILE%\\sg-tools\\pg.log).\n"
        + "Restart the whole stack — Postgres included — then re-run:\n"
        + "    powershell -ExecutionPolicy Bypass -File SecureGate/scripts/run-local-stack.ps1\n"
        + "    powershell -ExecutionPolicy Bypass -File SecureGate/scripts/run-local-stack.ps1 -RunTests\n"
        + "See SecureGate/README.md > \"Running from IntelliJ (or any IDE)\".";
  }

  private static String downMessage(String what, String url) {
    return "Shipping Hub "
        + what
        + " is not reachable at "
        + url
        + ".\n"
        + "These are black-box integration tests: they need a RUNNING Shipping Hub. Start the local\n"
        + "stack first, then re-run:\n"
        + "    powershell -ExecutionPolicy Bypass -File SecureGate/scripts/run-local-stack.ps1\n"
        + "    powershell -ExecutionPolicy Bypass -File SecureGate/scripts/run-local-stack.ps1 -RunTests\n"
        + "See SecureGate/README.md > \"Running from IntelliJ (or any IDE)\".";
  }

  private static boolean reachable(String url) {
    try {
      HttpClient client =
          HttpClient.newBuilder()
              // Force HTTP/1.1: the default HTTP/2 client sends an h2c upgrade that the Next.js dev
              // server mishandles (it answers with no bytes), so the web probe would wrongly time
              // out even when the app is up. Express ignores the upgrade, so this is safe for both.
              .version(HttpClient.Version.HTTP_1_1)
              .connectTimeout(TIMEOUT)
              .build();
      HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(TIMEOUT).GET().build();
      HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
      // Any HTTP answer means something is listening; only a 5xx hints the service is broken.
      return response.statusCode() < 500;
    } catch (Exception e) {
      return false;
    }
  }
}
