package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;

/** UI components for the site header, including the es/en language toggle. */
public final class SiteHeader {

  public static final Target LANGUAGE_TOGGLE =
      Target.the("language toggle").locatedBy("button[aria-label='Language']");

  private SiteHeader() {}
}
