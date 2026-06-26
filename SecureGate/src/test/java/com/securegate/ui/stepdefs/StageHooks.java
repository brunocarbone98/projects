package com.securegate.ui.stepdefs;

import com.securegate.support.SutPreflight;
import io.cucumber.java.After;
import io.cucumber.java.Before;
import net.serenitybdd.screenplay.actors.OnStage;
import net.serenitybdd.screenplay.actors.OnlineCast;
import org.junit.jupiter.api.Assumptions;

/**
 * Sets up the Screenplay "stage" before each scenario and tears it down afterwards.
 *
 * <p>It also guards the black-box suite: when the Shipping Hub (API or web) is down, the scenario is
 * <em>skipped</em> with one actionable message — {@link Assumptions#assumeTrue} throws a {@code
 * TestAbortedException}, which Cucumber maps to SKIPPED — instead of failing on a raw connection
 * error. See {@link SutPreflight}.
 */
public class StageHooks {

  @Before
  public void prepareStage() {
    // Bring the local Shipping Hub up if it is down (no-op once it is running), so green-arrowing a
    // scenario in the IDE just works. The UI drives the web, which calls the API, so both must be up.
    SutPreflight.ensureLocalStackReady();
    Assumptions.assumeTrue(SutPreflight.isApiReady(), SutPreflight::apiNotReadyMessage);
    Assumptions.assumeTrue(SutPreflight.isWebUp(), SutPreflight::webDownMessage);

    // An OnlineCast hands every actor the BrowseTheWeb ability, backed by Serenity's managed driver.
    OnStage.setTheStage(new OnlineCast());
  }

  @After
  public void clearStage() {
    try {
      OnStage.drawTheCurtain();
    } catch (RuntimeException noStageSet) {
      // The scenario was skipped before the stage was set (Shipping Hub down) — nothing to tear down.
    }
  }
}
