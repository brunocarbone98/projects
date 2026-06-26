package com.securegate.ui.stepdefs;

import static net.serenitybdd.screenplay.GivenWhenThen.seeThat;
import static net.serenitybdd.screenplay.actors.OnStage.theActorCalled;
import static net.serenitybdd.screenplay.actors.OnStage.theActorInTheSpotlight;
import static org.hamcrest.Matchers.is;

import com.securegate.ui.screenplay.questions.TheQuote;
import com.securegate.ui.screenplay.tasks.Navigate;
import com.securegate.ui.screenplay.tasks.RequestAQuote;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Screenplay steps for the public quote-calculator journey. */
public class QuoteStepDefinitions {

  @Given("{word} is on the quote page")
  public void isOnTheQuotePage(String actorName) {
    theActorCalled(actorName).attemptsTo(Navigate.toTheQuotePage());
  }

  @When("he calculates a quote with the default values")
  public void heCalculatesAQuote() {
    theActorInTheSpotlight().attemptsTo(RequestAQuote.withTheDefaults());
  }

  @Then("he sees a price")
  public void heSeesAPrice() {
    theActorInTheSpotlight().should(seeThat(TheQuote.showsAPrice(), is(true)));
  }
}
