package com.securegate.bdd;

import static io.restassured.RestAssured.given;

import com.securegate.support.Config;
import com.securegate.support.Specs;
import io.cucumber.java.en.When;
import java.util.Map;

/** Steps for the sign-in journey. */
public class AuthSteps {

  private final World world;

  public AuthSteps(World world) {
    this.world = world;
  }

  @When("I sign in with the demo customer credentials")
  public void iSignInWithValidCredentials() {
    world.response =
        given()
            .spec(Specs.api())
            .body(Map.of("email", Config.get().customerEmail(), "password", Config.get().customerPassword()))
            .post("/auth/login");
  }

  @When("I sign in with a wrong password")
  public void iSignInWithAWrongPassword() {
    world.response =
        given()
            .spec(Specs.api())
            .body(Map.of("email", Config.get().customerEmail(), "password", "definitely-wrong"))
            .post("/auth/login");
  }
}
