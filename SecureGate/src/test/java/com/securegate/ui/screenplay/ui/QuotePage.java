package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;

/** UI components for the public quote calculator. */
public final class QuotePage {

  public static final Target CALCULATE = Target.the("calculate button").locatedBy("button[type='submit']");

  // The result panel renders the price as a "$<amount>" string; an xpath catches any node showing it.
  public static final Target PRICE = Target.the("price").locatedBy("//*[contains(text(),'$')]");

  private QuotePage() {}
}
