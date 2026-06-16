package com.securegate.bdd;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.greaterThan;

import com.securegate.support.Payloads;
import com.securegate.support.Specs;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Steps for the shipping-quote journey. */
public class QuoteSteps {

  private final World world;

  public QuoteSteps(World world) {
    this.world = world;
  }

  @When("I request a quote for a 2 kg parcel to the US")
  public void iRequestAQuote() {
    world.response = given().spec(Specs.api()).body(Payloads.quote()).post("/quote");
  }

  @Then("the quote price should be positive")
  public void theQuotePriceShouldBePositive() {
    assertThat(world.response.jsonPath().getInt("priceCents"), greaterThan(0));
  }
}
