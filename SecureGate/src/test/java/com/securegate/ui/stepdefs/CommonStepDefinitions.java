package com.securegate.ui.stepdefs;

import static net.serenitybdd.screenplay.actors.OnStage.theActorCalled;

import com.securegate.ui.screenplay.tasks.Navigate;
import io.cucumber.java.en.Given;

/** Steps shared across journeys (e.g. the landing-page entry point used by several features). */
public class CommonStepDefinitions {

  @Given("{word} is on the Shipping Hub landing page")
  public void isOnTheLandingPage(String actorName) {
    theActorCalled(actorName).attemptsTo(Navigate.toTheLandingPage());
  }
}
