package com.securegate.ui.screenplay.tasks;

import static net.serenitybdd.screenplay.Tasks.instrumented;
import static net.serenitybdd.screenplay.matchers.WebElementStateMatchers.isVisible;

import com.securegate.ui.screenplay.ui.LandingPage;
import com.securegate.ui.screenplay.ui.TrackingResultPage;
import net.serenitybdd.screenplay.Actor;
import net.serenitybdd.screenplay.Task;
import net.serenitybdd.screenplay.actions.Click;
import net.serenitybdd.screenplay.actions.Enter;
import net.serenitybdd.screenplay.waits.WaitUntil;

/** Track a parcel from the landing page's hero form; lands on the tracking result page. */
public class TrackParcel implements Task {

  private final String code;

  public TrackParcel(String code) {
    this.code = code;
  }

  public static TrackParcel withCode(String code) {
    return instrumented(TrackParcel.class, code);
  }

  @Override
  public <T extends Actor> void performAs(T actor) {
    actor.attemptsTo(
        Enter.theValue(code).into(LandingPage.TRACK_INPUT),
        Click.on(LandingPage.TRACK_SUBMIT),
        // The hero form navigates client-side (router.push); wait for the URL, then the SSR result.
        WaitForUrl.containing("/tracking/" + code),
        WaitUntil.the(TrackingResultPage.CODE_HEADING, isVisible()).forNoMoreThan(15).seconds());
  }
}
