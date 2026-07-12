package com.securegate.ui.screenplay.questions;

import com.securegate.ui.screenplay.ui.TrackingResultPage;
import java.time.Duration;
import net.serenitybdd.screenplay.Question;
import net.serenitybdd.screenplay.abilities.BrowseTheWeb;
import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

/** Questions about the tracking result page. */
public final class TheTrackingResult {

  private TheTrackingResult() {}

  /** The tracking code shown in the monospace heading. */
  public static Question<String> code() {
    return actor -> TrackingResultPage.CODE_HEADING.resolveFor(actor).getText().trim();
  }

  /** The number of events in the timeline. */
  public static Question<Integer> eventCount() {
    return actor -> TrackingResultPage.EVENTS.resolveAllFor(actor).size();
  }

  /** True for the not-found / error view: an &lt;h1&gt; is shown, but no monospace code heading. */
  public static Question<Boolean> isNotFound() {
    return actor -> {
      WebDriver driver = BrowseTheWeb.as(actor).getDriver();
      new WebDriverWait(driver, Duration.ofSeconds(15))
          .until(ExpectedConditions.presenceOfElementLocated(By.tagName("h1")));
      return TrackingResultPage.CODE_HEADING.resolveAllFor(actor).isEmpty();
    };
  }
}
