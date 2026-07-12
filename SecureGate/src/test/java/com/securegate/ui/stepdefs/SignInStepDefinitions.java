package com.securegate.ui.stepdefs;

import static net.serenitybdd.screenplay.GivenWhenThen.seeThat;
import static net.serenitybdd.screenplay.actors.OnStage.theActorCalled;
import static net.serenitybdd.screenplay.actors.OnStage.theActorInTheSpotlight;
import static org.hamcrest.Matchers.is;

import com.securegate.support.Config;
import com.securegate.ui.screenplay.questions.CurrentPage;
import com.securegate.ui.screenplay.questions.TheLogin;
import com.securegate.ui.screenplay.tasks.Navigate;
import com.securegate.ui.screenplay.tasks.SignIn;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Screenplay steps for the sign-in journey. */
public class SignInStepDefinitions {

  @Given("{word} is on the sign-in page")
  public void isOnTheSignInPage(String actorName) {
    theActorCalled(actorName).attemptsTo(Navigate.toTheSignInPage());
  }

  @When("she signs in with the demo customer credentials")
  public void sheSignsInWithValidCredentials() {
    theActorInTheSpotlight()
        .attemptsTo(
            SignIn.withCredentials(Config.get().customerEmail(), Config.get().customerPassword()));
  }

  @When("she signs in with a wrong password")
  public void sheSignsInWithAWrongPassword() {
    theActorInTheSpotlight()
        .attemptsTo(SignIn.withCredentials(Config.get().customerEmail(), "definitely-wrong"));
  }

  @Then("she reaches the dashboard")
  public void sheReachesTheDashboard() {
    theActorInTheSpotlight().should(seeThat(CurrentPage.urlContains("/app"), is(true)));
  }

  @Then("she sees an inline error")
  public void sheSeesAnInlineError() {
    theActorInTheSpotlight().should(seeThat(TheLogin.errorIsShown(), is(true)));
  }
}
