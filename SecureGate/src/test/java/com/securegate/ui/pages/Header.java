package com.securegate.ui.pages;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;

/** The site header, including the es/en language toggle. */
public class Header extends BasePage {

  private static final By LOCALE_TOGGLE = By.cssSelector("button[aria-label='Language']");

  public Header(WebDriver driver) {
    super(driver);
  }

  public void switchLanguage() {
    clickable(LOCALE_TOGGLE).click();
  }
}
