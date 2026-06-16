package com.securegate.bdd;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;

import com.securegate.support.Specs;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;
import java.util.Map;

/** Steps for the wallet top-up journey. */
public class WalletSteps {

  private final World world;

  public WalletSteps(World world) {
    this.world = world;
  }

  @When("I top up my wallet by {int} cents")
  public void iTopUpMyWalletBy(int cents) {
    world.response =
        given()
            .spec(Specs.authed(world.accessToken))
            .body(Map.of("amountCents", cents, "idempotencyKey", "bdd-" + System.nanoTime()))
            .post("/wallet/topup");
  }

  @Then("my wallet balance should be {int} cents")
  public void myWalletBalanceShouldBe(int cents) {
    assertThat(world.response.jsonPath().getInt("balanceCents"), is(cents));
  }
}
