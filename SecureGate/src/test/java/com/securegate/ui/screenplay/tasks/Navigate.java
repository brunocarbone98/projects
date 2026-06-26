package com.securegate.ui.screenplay.tasks;

import com.securegate.ui.Site;
import net.serenitybdd.screenplay.Performable;
import net.serenitybdd.screenplay.Task;
import net.serenitybdd.screenplay.actions.Open;

/** Navigation tasks — open Shipping Hub web pages by their {@code /en}-locale path. */
public final class Navigate {

  private Navigate() {}

  public static Performable toTheLandingPage() {
    return toThePath("/");
  }

  public static Performable toTheQuotePage() {
    return toThePath("/quote");
  }

  public static Performable toTheSignInPage() {
    return toThePath("/login");
  }

  public static Performable toTheTrackingPageFor(String code) {
    return toThePath("/tracking/" + code);
  }

  /** Open an arbitrary {@code /en} path. */
  public static Performable toThePath(String path) {
    return Task.where("{0} opens " + path, Open.url(Site.url(path)));
  }
}
