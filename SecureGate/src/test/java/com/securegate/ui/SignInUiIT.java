package com.securegate.ui;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.securegate.support.Config;
import com.securegate.ui.pages.DashboardPage;
import com.securegate.ui.pages.LoginPage;
import com.securegate.ui.support.BaseUiIT;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Phase 3 — the sign-in journey through the web UI (success + invalid credentials). */
@DisplayName("UI: sign in")
class SignInUiIT extends BaseUiIT {

  @Test
  @DisplayName("signing in with valid credentials reaches the dashboard")
  void signInReachesDashboard() {
    open("/login");
    new LoginPage(driver).signIn(Config.get().customerEmail(), Config.get().customerPassword());
    assertTrue(new DashboardPage(driver).isLoaded());
  }

  @Test
  @DisplayName("a wrong password shows an inline error")
  void wrongPasswordShowsError() {
    open("/login");
    LoginPage login = new LoginPage(driver);
    login.signIn(Config.get().customerEmail(), "definitely-wrong");
    assertTrue(login.errorIsShown());
  }
}
