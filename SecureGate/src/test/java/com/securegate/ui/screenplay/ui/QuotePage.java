package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;
import org.openqa.selenium.By;

/** UI components for the public quote calculator. */
public final class QuotePage {

  public static final Target CALCULATE =
      Target.the("calculate button").located(By.cssSelector("button[type='submit']"));

  // The result panel renders the price as a "$<amount>" string; an xpath catches any node showing it.
  public static final Target PRICE =
      Target.the("price").located(By.xpath("//*[contains(text(),'$')]"));

  private QuotePage() {}
}
