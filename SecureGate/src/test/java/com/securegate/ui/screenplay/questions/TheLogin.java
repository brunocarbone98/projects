package com.securegate.ui.screenplay.questions;

import com.securegate.ui.screenplay.ui.LoginPage;
import net.serenitybdd.screenplay.Question;

/** Questions about the sign-in page. */
public final class TheLogin {

  private TheLogin() {}

  /** True once the inline error alert (shown on invalid credentials) is visible. */
  public static Question<Boolean> errorIsShown() {
    return actor -> {
      try {
        LoginPage.ERROR.resolveFor(actor).waitUntilVisible();
        return true;
      } catch (RuntimeException notShown) {
        return false;
      }
    };
  }
}
