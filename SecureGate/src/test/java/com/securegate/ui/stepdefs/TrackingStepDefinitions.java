package com.securegate.ui.stepdefs;

import static net.serenitybdd.screenplay.GivenWhenThen.seeThat;
import static net.serenitybdd.screenplay.actors.OnStage.theActorCalled;
import static net.serenitybdd.screenplay.actors.OnStage.theActorInTheSpotlight;
import static org.hamcrest.Matchers.equalTo;
import static org.hamcrest.Matchers.greaterThan;
import static org.hamcrest.Matchers.is;

import com.securegate.ui.Site;
import com.securegate.ui.screenplay.questions.TheTrackingResult;
import com.securegate.ui.screenplay.tasks.Navigate;
import com.securegate.ui.screenplay.tasks.TrackParcel;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Screenplay steps for the public tracking journey. */
public class TrackingStepDefinitions {

  @When("she tracks the seeded demo parcel")
  public void sheTracksTheSeededDemoParcel() {
    theActorInTheSpotlight().attemptsTo(TrackParcel.withCode(Site.demoTrackingCode()));
  }

  @Then("she sees the tracking timeline for that parcel")
  public void sheSeesTheTrackingTimeline() {
    theActorInTheSpotlight()
        .should(
            seeThat(TheTrackingResult.code(), equalTo(Site.demoTrackingCode())),
            seeThat(TheTrackingResult.eventCount(), greaterThan(0)));
  }

  @Given("{word} opens the tracking page for an unknown code")
  public void opensTheTrackingPageForAnUnknownCode(String actorName) {
    theActorCalled(actorName).attemptsTo(Navigate.toTheTrackingPageFor("PTY-2026-987654-1"));
  }

  @Then("she sees the not-found view")
  public void sheSeesTheNotFoundView() {
    theActorInTheSpotlight().should(seeThat(TheTrackingResult.isNotFound(), is(true)));
  }
}
