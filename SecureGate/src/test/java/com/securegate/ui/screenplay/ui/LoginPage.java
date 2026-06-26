package com.securegate.ui.screenplay.ui;

import net.serenitybdd.screenplay.targets.Target;

/** UI components for the sign-in page. */
public final class LoginPage {

  public static final Target EMAIL = Target.the("email field").locatedBy("#email");
  public static final Target PASSWORD = Target.the("password field").locatedBy("#password");
  public static final Target SUBMIT = Target.the("sign-in button").locatedBy("button[type='submit']");
  public static final Target ERROR = Target.the("inline error").locatedBy("p[role='alert']");

  private LoginPage() {}
}
