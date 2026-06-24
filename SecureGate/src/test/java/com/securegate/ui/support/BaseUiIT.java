package com.securegate.ui.support;

import com.securegate.support.Config;
import com.securegate.support.SutPreflight;
import java.time.Duration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.extension.ExtendWith;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.WebDriverWait;

/**
 * Base class for Selenium UI tests. Drives the Shipping Hub web app at {@code webBaseUrl} on the
 * {@code /en} locale. Tagged {@code ui} (excluded from the default run, since it needs a running
 * web app + a browser); the CI ui job runs it with the web up.
 */
@Tag("ui")
@ExtendWith(ScreenshotOnFailure.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public abstract class BaseUiIT {

  protected WebDriver driver;
  protected WebDriverWait wait;
  private final String base = Config.get().webBaseUrl();

  @BeforeAll
  void startBrowser() {
    // The UI suite drives the web app, which in turn calls the API — skip with a clear message
    // (rather than launching Chrome only to fail) when either side of the stack is down, including
    // the case where the API is up but its database is dead (every page would render an error).
    Assumptions.assumeTrue(SutPreflight.isApiReady(), SutPreflight::apiNotReadyMessage);
    Assumptions.assumeTrue(SutPreflight.isWebUp(), SutPreflight::webDownMessage);
    driver = Browser.start();
    wait = new WebDriverWait(driver, Duration.ofSeconds(15));
  }

  @AfterAll
  void stopBrowser() {
    Browser.quit();
  }

  /** Navigate to an {@code /en} path, e.g. {@code open("/tracking/PTY-2026-001001-0")}. */
  protected void open(String path) {
    driver.get(base + "/en" + path);
  }
}
