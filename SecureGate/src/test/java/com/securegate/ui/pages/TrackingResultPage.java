package com.securegate.ui.pages;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.ExpectedConditions;

/** The SSR tracking result page at {@code /en/tracking/<code>}. */
public class TrackingResultPage extends BasePage {

  // The tracking code is rendered as a monospace <h1>; the timeline is an <ol> of events.
  private static final By CODE_HEADING = By.cssSelector("h1.font-mono");
  private static final By EVENTS = By.cssSelector("ol li");

  public TrackingResultPage(WebDriver driver) {
    super(driver);
  }

  public String trackingCode() {
    return visible(CODE_HEADING).getText().trim();
  }

  public int eventCount() {
    visible(EVENTS); // wait for at least one timeline entry
    return driver.findElements(EVENTS).size();
  }

  /** True for the not-found / error view: an &lt;h1&gt; is shown, but no monospace code heading. */
  public boolean isNotFound() {
    wait.until(ExpectedConditions.presenceOfElementLocated(By.tagName("h1")));
    return driver.findElements(CODE_HEADING).isEmpty();
  }
}
