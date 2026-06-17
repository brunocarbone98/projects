package com.securegate.ui.pages;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;

/** The sign-in page. */
public class LoginPage extends BasePage {

  private static final By EMAIL = By.id("email");
  private static final By PASSWORD = By.id("password");
  private static final By SUBMIT = By.cssSelector("button[type='submit']");
  private static final By ERROR = By.cssSelector("p[role='alert']");

  public LoginPage(WebDriver driver) {
    super(driver);
  }

  public void signIn(String email, String password) {
    visible(EMAIL).sendKeys(email);
    driver.findElement(PASSWORD).sendKeys(password);
    clickable(SUBMIT).click();
  }

  /** Waits for and reports the inline error alert (shown on invalid credentials). */
  public boolean errorIsShown() {
    return visible(ERROR).isDisplayed();
  }
}
