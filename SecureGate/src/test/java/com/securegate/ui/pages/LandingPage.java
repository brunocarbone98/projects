package com.securegate.ui.pages;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.support.ui.ExpectedConditions;

/** The public landing page with the hero "track a parcel" form. */
public class LandingPage extends BasePage {

  private static final By TRACK_INPUT = By.cssSelector("input[placeholder^='PTY']");

  public LandingPage(WebDriver driver) {
    super(driver);
  }

  /** Enter a tracking code in the hero form and submit; lands on the tracking result page. */
  public TrackingResultPage trackByCode(String code) {
    WebElement input = visible(TRACK_INPUT);
    input.clear();
    input.sendKeys(code);
    // Submit the button inside the same form as the tracking input (robust to other forms).
    input
        .findElement(By.xpath("./ancestor::form"))
        .findElement(By.cssSelector("button[type='submit']"))
        .click();
    // The form navigates client-side (router.push); wait for the URL before continuing.
    wait.until(ExpectedConditions.urlContains("/tracking/" + code));
    return new TrackingResultPage(driver);
  }
}
