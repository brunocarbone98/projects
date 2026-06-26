package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;
import org.openqa.selenium.By;

/** UI components for the sign-in page. */
public final class LoginPage {

  public static final Target EMAIL = Target.the("email field").located(By.cssSelector("#email"));
  public static final Target PASSWORD =
      Target.the("password field").located(By.cssSelector("#password"));
  public static final Target SUBMIT =
      Target.the("sign-in button").located(By.cssSelector("button[type='submit']"));
  public static final Target ERROR =
      Target.the("inline error").located(By.cssSelector("p[role='alert']"));

  private LoginPage() {}
}
