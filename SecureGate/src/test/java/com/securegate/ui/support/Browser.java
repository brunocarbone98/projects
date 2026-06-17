package com.securegate.ui.support;

import java.io.File;
import java.time.Duration;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeDriverService;
import org.openqa.selenium.chrome.ChromeOptions;

/**
 * Headless-Chrome WebDriver lifecycle. Selenium Manager (bundled with Selenium 4) resolves the
 * matching driver automatically; a specific browser binary can be forced with
 * {@code -Dchrome.binary=...} or the {@code CHROME_BIN} env var.
 */
public final class Browser {

  private static WebDriver driver;

  private Browser() {}

  public static WebDriver start() {
    ChromeOptions options = new ChromeOptions();
    options.addArguments(
        "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
        "--window-size=1280,900");
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
