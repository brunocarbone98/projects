package com.securegate.bdd;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.greaterThan;

import com.securegate.support.Config;
import com.securegate.support.Specs;
import com.securegate.support.TrackingCodes;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Steps for the public tracking journey. */
public class TrackingSteps {

  private final World world;

  public TrackingSteps(World world) {
    this.world = world;
  }

  @When("I track the seeded demo parcel")
  public void iTrackTheSeededDemoParcel() {
    world.response = given().spec(Specs.api()).get("/tracking/{c}", Config.get().demoTrackingCode());
  }

  @When("I track the code {string}")
  public void iTrackTheCode(String code) {
    world.response = given().spec(Specs.api()).get("/tracking/{c}", code);
  }

  @When("I track a malformed code")
  public void iTrackAMalformedCode() {
    world.response = given().spec(Specs.api()).get("/tracking/{c}", TrackingCodes.MALFORMED);
  }

  @Then("the parcel timeline should not be empty")
  public void theParcelTimelineShouldNotBeEmpty() {
    assertThat(world.response.jsonPath().getList("events").size(), greaterThan(0));
  }
}
