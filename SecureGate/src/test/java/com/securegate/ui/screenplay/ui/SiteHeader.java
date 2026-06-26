package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;
import org.openqa.selenium.By;

/** UI components for the site header, including the es/en language toggle. */
public final class SiteHeader {

  public static final Target LANGUAGE_TOGGLE =
      Target.the("language toggle").located(By.cssSelector("button[aria-label='Language']"));

  private SiteHeader() {}
}
