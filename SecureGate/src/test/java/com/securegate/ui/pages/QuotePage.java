package com.securegate.ui.pages;

import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;

/** The public quote calculator. */
public class QuotePage extends BasePage {

  private static final By CALCULATE = By.cssSelector("button[type='submit']");

  public QuotePage(WebDriver driver) {
    super(driver);
  }

  /** Submit the quote form using its defaults (destination US, 2 kg, Express). */
  public void calculate() {
    clickable(CALCULATE).click();
  }

  /** Waits until the result panel shows a price (a {@code $} amount). */
  public boolean showsPrice() {
    return wait.until(
        d ->
            d.findElements(By.tagName("p")).stream()
                .map(WebElement::getText)
                .anyMatch(t -> t != null && t.matches(".*\\$\\s?\\d.*")));
  }
}
