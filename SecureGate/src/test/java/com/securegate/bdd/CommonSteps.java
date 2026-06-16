package com.securegate.bdd;

import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;

import com.securegate.support.Auth;
import io.cucumber.java.en.Given;
import io.cucumber.java.en.Then;

/** Shared steps: signing in and generic response assertions. */
public class CommonSteps {

  private final World world;

  public CommonSteps(World world) {
    this.world = world;
  }

  @Given("I am signed in as the demo customer")
  public void signedInAsDemoCustomer() {
    world.accessToken = Auth.customerToken();
  }

  @Given("I am signed in as a new customer")
  public void signedInAsNewCustomer() {
    world.accessToken = Auth.registerFresh().accessToken();
  }

  @Given("I am not signed in")
  public void notSignedIn() {
    world.accessToken = null;
  }

  @Then("the response status should be {int}")
  public void theResponseStatusShouldBe(int status) {
    assertThat(world.response.statusCode(), is(status));
  }

  @Then("the error code should be {string}")
  public void theErrorCodeShouldBe(String code) {
    assertThat(world.response.jsonPath().getString("error.code"), is(code));
  }
}
