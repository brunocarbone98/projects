package com.securegate.ui.pages;

import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.ExpectedConditions;

/** The authenticated dashboard at {@code /en/app}. */
public class DashboardPage extends BasePage {

  public DashboardPage(WebDriver driver) {
    super(driver);
  }

  /** True once the post-login redirect to the dashboard ({@code /en/app}) has completed. */
  public boolean isLoaded() {
    return wait.until(ExpectedConditions.urlContains("/app"));
  }
}
