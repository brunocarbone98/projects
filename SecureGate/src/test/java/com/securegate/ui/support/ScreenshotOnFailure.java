package com.securegate.ui.support;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.extension.TestWatcher;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import org.openqa.selenium.WebDriver;

/** Saves a PNG screenshot to {@code target/screenshots} when a UI test fails. */
public class ScreenshotOnFailure implements TestWatcher {

  @Override
  public void testFailed(ExtensionContext context, Throwable cause) {
    WebDriver driver = Browser.get();
    if (!(driver instanceof TakesScreenshot)) {
      return;
    }
    try {
      byte[] png = ((TakesScreenshot) driver).getScreenshotAs(OutputType.BYTES);
      Path dir = Paths.get("target", "screenshots");
      Files.createDirectories(dir);
      String name =
          context.getTestClass().map(Class::getSimpleName).orElse("test")
              + "_"
              + context.getDisplayName().replaceAll("[^a-zA-Z0-9.-]", "_")
              + ".png";
      Files.write(dir.resolve(name), png);
    } catch (Exception ignored) {
      // a screenshot is best-effort; never mask the real test failure
    }
  }
}
