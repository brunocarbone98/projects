package com.securegate.ui.support;

import java.io.File;
import java.time.Duration;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeDriverService;
import org.openqa.selenium.chrome.ChromeOptions;

/**
 * Chrome WebDriver lifecycle. Selenium Manager (bundled with Selenium 4) resolves the matching
 * driver automatically; a specific browser binary can be forced with {@code -Dchrome.binary=...}
 * or the {@code CHROME_BIN} env var.
 *
 * <p>By default Chrome runs in a real, <em>visible</em> window so you can watch the tests replay
 * their scripted actions. CI (or any headless machine) can opt back into headless mode with
 * {@code -Dheadless=true} (or by setting the {@code HEADLESS=true} env var), e.g.
 * {@code ./mvnw verify -Denv=local -Dheadless=true}.
 */
public final class Browser {

  private static WebDriver driver;

  // The installed Chrome is often newer than the CDP versions Selenium bundles, which makes
  // Selenium log a noisy (but harmless) "Unable to find CDP implementation matching ..." warning on
  // every driver start. The UI tests use only the standard WebDriver protocol, not CDP, so we mute
  // those loggers. NOTE: JUL keeps only weak references to loggers, so we must hold strong
  // references in static fields — otherwise the configured loggers get garbage-collected and are
  // recreated with their default (warning-emitting) level.
  private static final Logger CDP_VERSION_FINDER_LOG =
      Logger.getLogger("org.openqa.selenium.devtools.CdpVersionFinder");
  private static final Logger CHROMIUM_DRIVER_LOG =
      Logger.getLogger("org.openqa.selenium.chromium.ChromiumDriver");

  static {
    CDP_VERSION_FINDER_LOG.setLevel(Level.OFF);
    CHROMIUM_DRIVER_LOG.setLevel(Level.OFF);
  }

  private Browser() {}

  public static WebDriver start() {
    ChromeOptions options = new ChromeOptions();
    options.addArguments(
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,900");
    if (isHeadless()) {
      options.addArguments("--headless=new");
    }
    String binary = System.getProperty("chrome.binary", System.getenv("CHROME_BIN"));
    if (binary != null && !binary.isBlank()) {
      options.setBinary(binary);
    }
    // Use an explicit chromedriver when provided (CI pins one that matches the installed
    // Chrome, avoiding a stale driver on PATH); otherwise let Selenium Manager resolve it.
    String driverPath =
        System.getProperty("webdriver.chrome.driver", System.getenv("CHROMEDRIVER_BIN"));
    if (driverPath != null && !driverPath.isBlank()) {
      ChromeDriverService service =
          new ChromeDriverService.Builder().usingDriverExecutable(new File(driverPath)).build();
      driver = new ChromeDriver(service, options);
    } else {
      driver = new ChromeDriver(options);
    }
    driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(30));
    return driver;
  }

  /**
   * Visible by default so you can watch the test replay the scripted actions. Set
   * {@code -Dheadless=true} (or {@code HEADLESS=true}) on CI/headless machines to run without a
   * window.
   */
  private static boolean isHeadless() {
    String flag = System.getProperty("headless", System.getenv("HEADLESS"));
    return flag != null && flag.equalsIgnoreCase("true");
  }

  public static WebDriver get() {
    return driver;
  }

  public static void quit() {
    if (driver != null) {
      driver.quit();
      driver = null;
    }
  }
}
