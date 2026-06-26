package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;

/** UI components for the SSR tracking result page at {@code /en/tracking/<code>}. */
public final class TrackingResultPage {

  // The tracking code is rendered as a monospace <h1>; the timeline is an <ol> of events.
  public static final Target CODE_HEADING = Target.the("tracking-code heading").locatedBy("h1.font-mono");
  public static final Target EVENTS = Target.the("timeline events").locatedBy("ol li");
  public static final Target ANY_HEADING = Target.the("page heading").locatedBy("h1");

  private TrackingResultPage() {}
}
