package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;

/**
 * UI components for the public landing page (the hero "track a parcel" form). In Screenplay these
 * {@link Target}s replace a Page Object's fields — they describe <em>what</em> an element is, while
 * the Tasks/Questions describe <em>what the actor does</em> with it.
 */
public final class LandingPage {

  public static final Target TRACK_INPUT =
      Target.the("tracking-code input").locatedBy("input[placeholder^='PTY']");

  // The submit button inside the same form as the tracking input.
  public static final Target TRACK_SUBMIT =
      Target.the("track button").locatedBy("form:has(input[placeholder^='PTY']) button[type='submit']");

  private LandingPage() {}
}
