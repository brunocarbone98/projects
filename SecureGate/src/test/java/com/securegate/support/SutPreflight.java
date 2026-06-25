package com.securegate.support;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

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
 *
 * <p><b>Auto-start.</b> So that running the suite from the IDE (green-arrow) or {@code mvnw verify}
 * "just works", {@link #ensureLocalStackReady()} brings the local stack up on the first preflight of
 * a run when it is down. This removes the manual "start the stack first" step that otherwise made a
 * fresh IDE session skip every test until {@code run-local-stack.ps1} was run by hand. It is gated
 * to {@code -Denv=local} on Windows, never runs in CI, and can be turned off with
 * {@code -Dsg.autostart=false}; if it cannot start the stack it falls back to the skip-with-message
 * behavior, so a run is never worse than before.
 */
public final class SutPreflight {

  private static final Duration TIMEOUT = Duration.ofSeconds(5);

  private static volatile Boolean apiReachable;
  private static volatile Boolean apiDbHealthy;
  private static volatile Boolean webUp;

  // Auto-start is attempted at most once per JVM, guarded by this lock.
  private static final Object STARTUP_LOCK = new Object();
  private static volatile boolean startupAttempted;

  private SutPreflight() {}

  /**
   * Best-effort: if the local Shipping Hub is down, start it so the suite has something to talk to.
   *
   * <p>Called by the test base classes and the BDD {@code @Before} hook before they probe readiness.
   * Every test here is black-box and needs a RUNNING Shipping Hub, but the stack is a set of detached
   * background processes that do not survive a reboot / log-off / IDE restart — and green-arrowing the
   * tests in the IDE does not run the {@code .run} "start local stack" config. So without this a fresh
   * session skipped every test until the stack was started by hand. This runs
   * {@code scripts/run-local-stack.ps1} once and waits until the stack is up.
   *
   * <p>Deliberately conservative — it never makes a run worse than the old skip-with-message path:
   *
   * <ul>
   *   <li>runs at most once per JVM;
   *   <li>only for {@code -Denv=local} on Windows, and never in CI (the {@code CI} env var) — CI
   *       brings the stack up itself — and can be disabled with {@code -Dsg.autostart=false};
   *   <li>a no-op when the stack is already up;
   *   <li>if the script is missing, fails, or times out (cap: {@code -Dsg.autostart.timeoutSeconds},
   *       default 600), it logs a warning and returns, leaving the caller's
   *       {@code assumeTrue(isApiReady())} to skip the suite with the usual actionable message.
   * </ul>
   */
  public static void ensureLocalStackReady() {
    if (startupAttempted) {
      return;
    }
    synchronized (STARTUP_LOCK) {
      if (startupAttempted) {
        return;
      }
      startupAttempted = true;
      if (!autoStartEnabled() || isApiReady()) {
        return; // disabled/not-applicable, or already up — nothing to do
      }
      System.out.println(
          "[SecureGate] Shipping Hub is down - starting the local stack "
              + "(this can take a minute or two the first time)...");
      try {
        startLocalStack();
        System.out.println("[SecureGate] Local stack is up.");
      } catch (Exception e) {
        System.err.println(
            "[SecureGate] Auto-start of the local Shipping Hub failed ("
                + e.getMessage()
                + "). The suite will be skipped; start it by hand with "
                + "scripts/run-local-stack.ps1, or disable auto-start with -Dsg.autostart=false.");
      } finally {
        // Re-probe from scratch after a start attempt so isApiReady() reflects the new state.
        resetProbeCache();
      }
    }
  }

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

  /** Auto-start applies only to the local target on Windows, outside CI, unless turned off. */
  private static boolean autoStartEnabled() {
    if (!Boolean.parseBoolean(System.getProperty("sg.autostart", "true"))) {
      return false;
    }
    if (System.getenv("CI") != null) {
      return false; // CI stands the stack up itself before the suite runs
    }
    if (!"local".equals(Config.get().env())) {
      return false; // only manage a local Shipping Hub, never a live/remote one
    }
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
  }

  /** Runs {@code scripts/run-local-stack.ps1} and blocks until it finishes (or times out). */
  private static void startLocalStack() throws Exception {
    File script = findStackScript();
    if (script == null) {
      throw new IllegalStateException(
          "could not locate scripts/run-local-stack.ps1 from " + System.getProperty("user.dir"));
    }
    long timeoutSeconds = Long.getLong("sg.autostart.timeoutSeconds", 600L);
    // script is .../SecureGate/scripts/run-local-stack.ps1 -> ../.. is the SecureGate module dir.
    File logDir = new File(script.getParentFile().getParentFile(), "target");
    logDir.mkdirs();
    File log = new File(logDir, "local-stack-autostart.log");
    // Feed an empty stdin and capture output to a file rather than inheriting IO: a forked test JVM's
    // inherited stdin can leave a tool (pnpm/prisma) blocked on a prompt forever, and its inherited
    // output does not reliably surface in the runner console. A log file is non-blocking and lets us
    // point the user straight at the script's progress.
    File emptyStdin = File.createTempFile("sg-stack-stdin", ".txt");
    emptyStdin.deleteOnExit();
    System.out.println("[SecureGate] Bringing the stack up; live progress -> " + log.getAbsolutePath());
    Process process =
        new ProcessBuilder(
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script.getAbsolutePath())
            .redirectErrorStream(true)
            .redirectInput(emptyStdin)
            .redirectOutput(log)
            .start();
    if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
      process.destroyForcibly();
      throw new IllegalStateException(
          "run-local-stack.ps1 did not finish within " + timeoutSeconds + "s (see " + log + ")");
    }
    if (process.exitValue() != 0) {
      throw new IllegalStateException(
          "run-local-stack.ps1 exited with code " + process.exitValue() + " (see " + log + ")");
    }
  }

  /** Walks up from the working directory to find the stack script (CWD may be the module or repo root). */
  private static File findStackScript() {
    File dir = new File(System.getProperty("user.dir", ".")).getAbsoluteFile();
    for (int i = 0; i < 6 && dir != null; i++, dir = dir.getParentFile()) {
      File direct = new File(dir, "scripts/run-local-stack.ps1");
      if (direct.isFile()) {
        return direct;
      }
      File nested = new File(dir, "SecureGate/scripts/run-local-stack.ps1");
      if (nested.isFile()) {
        return nested;
      }
    }
    return null;
  }

  /** Clears the per-JVM probe cache so the next {@link #isApiReady()} re-checks the live stack. */
  private static void resetProbeCache() {
    apiReachable = null;
    apiDbHealthy = null;
    webUp = null;
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
