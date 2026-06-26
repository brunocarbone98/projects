package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;
import org.openqa.selenium.By;

/**
 * UI components for the public landing page (the hero "track a parcel" form). In Screenplay these
 * {@link Target}s replace a Page Object's fields — they describe <em>what</em> an element is, while
 * the Tasks/Questions describe <em>what the actor does</em> with it.
 *
 * <p>Locators use explicit {@link By} (not the css/xpath auto-detecting {@code locatedBy(String)}):
 * Serenity's heuristic misreads {@code [attr='value']} CSS as XPath, so we pin the strategy.
 */
public final class LandingPage {

  public static final Target TRACK_INPUT =
      Target.the("tracking-code input").located(By.cssSelector("input[placeholder^='PTY']"));

  // The submit button inside the same form as the tracking input (robust to other forms on the page).
  public static final Target TRACK_SUBMIT =
      Target.the("track button")
          .located(
              By.xpath("//input[starts-with(@placeholder,'PTY')]/ancestor::form//button[@type='submit']"));

  private LandingPage() {}
}
