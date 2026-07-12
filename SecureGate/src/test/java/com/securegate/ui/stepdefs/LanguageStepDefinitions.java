package com.securegate.ui.stepdefs;

import static net.serenitybdd.screenplay.GivenWhenThen.seeThat;
import static net.serenitybdd.screenplay.actors.OnStage.theActorInTheSpotlight;
import static org.hamcrest.Matchers.containsString;

import com.securegate.ui.screenplay.questions.CurrentPage;
import com.securegate.ui.screenplay.tasks.SwitchLanguage;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Screenplay steps for the es/en language switch. */
public class LanguageStepDefinitions {

  @When("she switches the language to Spanish")
  public void sheSwitchesTheLanguageToSpanish() {
    theActorInTheSpotlight().attemptsTo(SwitchLanguage.toSpanish());
  }

  @Then("the page URL is on the Spanish locale")
  public void thePageUrlIsOnTheSpanishLocale() {
    theActorInTheSpotlight().should(seeThat(CurrentPage.url(), containsString("/es")));
  }
}
