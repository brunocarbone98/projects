package com.securegate.bdd;

import static io.restassured.RestAssured.given;
import static org.hamcrest.MatcherAssert.assertThat;
import static org.hamcrest.Matchers.is;
import static org.hamcrest.Matchers.matchesPattern;

import com.securegate.support.Payloads;
import com.securegate.support.Specs;
import io.cucumber.java.en.Then;
import io.cucumber.java.en.When;

/** Steps for the create-shipment journey. */
public class ShipmentSteps {

  private final World world;

  public ShipmentSteps(World world) {
    this.world = world;
  }

  @When("I create a shipment")
  public void iCreateAShipment() {
    world.response =
        given().spec(Specs.authed(world.accessToken)).body(Payloads.newShipment()).post("/shipments");
    if (world.response.statusCode() == 201) {
      world.shipmentId = world.response.jsonPath().getString("id");
    }
  }

  @When("I try to create a shipment")
  public void iTryToCreateAShipment() {
    var spec = world.accessToken == null ? Specs.api() : Specs.authed(world.accessToken);
    world.response = given().spec(spec).body(Payloads.newShipment()).post("/shipments");
  }

  @Then("the shipment status should be {string}")
  public void theShipmentStatusShouldBe(String status) {
    assertThat(world.response.jsonPath().getString("status"), is(status));
  }

  @Then("the shipment should have a valid tracking code")
  public void theShipmentShouldHaveAValidTrackingCode() {
    assertThat(world.response.jsonPath().getString("trackingCode"), matchesPattern("^PTY-\\d{4}-\\d{6}-\\d$"));
  }
}
