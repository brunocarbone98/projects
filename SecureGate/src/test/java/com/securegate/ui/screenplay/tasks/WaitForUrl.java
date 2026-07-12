package com.securegate.ui.screenplay.tasks;

import static net.serenitybdd.screenplay.Tasks.instrumented;

import java.time.Duration;
import net.serenitybdd.screenplay.Actor;
import net.serenitybdd.screenplay.Task;
import net.serenitybdd.screenplay.abilities.BrowseTheWeb;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

/**
 * Explicit wait until the browser URL contains a fragment — used for client-side navigations
 * (router pushes) that have no element to wait on. Explicit conditions only; never {@code
 * Thread.sleep}.
 */
public class WaitForUrl implements Task {

  private final String fragment;

  public WaitForUrl(String fragment) {
    this.fragment = fragment;
  }

  public static WaitForUrl containing(String fragment) {
    return instrumented(WaitForUrl.class, fragment);
  }

  @Override
  public <T extends Actor> void performAs(T actor) {
    WebDriver driver = BrowseTheWeb.as(actor).getDriver();
    new WebDriverWait(driver, Duration.ofSeconds(15))
        .until(ExpectedConditions.urlContains(fragment));
  }
}
