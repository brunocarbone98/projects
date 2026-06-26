package com.securegate.ui.screenplay.tasks;

import static net.serenitybdd.screenplay.Tasks.instrumented;

import com.securegate.ui.screenplay.ui.SiteHeader;
import net.serenitybdd.screenplay.Actor;
import net.serenitybdd.screenplay.Task;
import net.serenitybdd.screenplay.actions.Click;

/** Toggle the site language from English to Spanish via the header control. */
public class SwitchLanguage implements Task {

  public static SwitchLanguage toSpanish() {
    return instrumented(SwitchLanguage.class);
  }

  @Override
  public <T extends Actor> void performAs(T actor) {
    actor.attemptsTo(
        Click.on(SiteHeader.LANGUAGE_TOGGLE),
        // The toggle navigates client-side to the /es locale; wait for the URL to flip.
        WaitForUrl.containing("/es"));
  }
}
