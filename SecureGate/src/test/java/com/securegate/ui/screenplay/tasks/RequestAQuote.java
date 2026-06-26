package com.securegate.ui.screenplay.tasks;

import static net.serenitybdd.screenplay.Tasks.instrumented;
import static net.serenitybdd.screenplay.matchers.WebElementStateMatchers.isVisible;

import com.securegate.ui.screenplay.ui.QuotePage;
import net.serenitybdd.screenplay.Actor;
import net.serenitybdd.screenplay.Task;
import net.serenitybdd.screenplay.actions.Click;
import net.serenitybdd.screenplay.waits.WaitUntil;

/** Submit the quote form with its defaults (destination US, 2 kg, Express) and wait for a price. */
public class RequestAQuote implements Task {

  public static RequestAQuote withTheDefaults() {
    return instrumented(RequestAQuote.class);
  }

  @Override
  public <T extends Actor> void performAs(T actor) {
    actor.attemptsTo(
        Click.on(QuotePage.CALCULATE),
        WaitUntil.the(QuotePage.PRICE, isVisible()).forNoMoreThan(15).seconds());
  }
}
