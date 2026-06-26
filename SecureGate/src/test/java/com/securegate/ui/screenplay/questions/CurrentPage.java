package com.securegate.ui.screenplay.questions;

import java.time.Duration;
import net.serenitybdd.screenplay.Question;
import net.serenitybdd.screenplay.abilities.BrowseTheWeb;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

/** Questions about the browser's current location. */
public final class CurrentPage {

  private CurrentPage() {}

  /** The browser's current URL. */
  public static Question<String> url() {
    return actor -> BrowseTheWeb.as(actor).getDriver().getCurrentUrl();
  }

  /** True once the URL contains the given fragment (waits up to 15s). */
  public static Question<Boolean> urlContains(String fragment) {
    return actor -> {
      WebDriver driver = BrowseTheWeb.as(actor).getDriver();
      new WebDriverWait(driver, Duration.ofSeconds(15))
          .until(ExpectedConditions.urlContains(fragment));
      return true;
    };
  }
}
